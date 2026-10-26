(() => {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const app = $("meetingApp");
    const roomId = app.dataset.roomId;
    const myName = (app.dataset.name || "Guest").trim().slice(0, 60) || "Guest";

    const grid = $("video-grids");
    const localVideo = $("localVideo");
    const localPlaceholder = $("localPlaceholder");
    const localMicStatus = $("localMicStatus");
    const callNotice = $("callNotice");
    const toastEl = $("toast");
    const workspace = document.querySelector(".workspace");
    const sidePanel = $("sidePanel");

    const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };

    const socket = io();
    const roster = new Map(); // peerId -> { id (socket id), peerId, name, mic, cam }
    const tiles = new Map();  // peerId -> { el, video, placeholder, avatar, nameEl, mic }
    const calls = new Map();  // peerId -> MediaConnection

    let peer = null;
    let selfId = null;
    let localStream = null;
    let realAudio = null;
    let realVideo = null;
    let screenTrack = null;
    let silentAudio = null;
    let blankVideo = null;
    let joined = false;
    let panel = "chat";

    /* ---------- small helpers ---------- */

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const icon = (classes) => el("i", classes);
    const initial = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";
    const notice = (text) => { callNotice.textContent = text; };

    let toastTimer;
    const toast = (text) => {
        toastEl.textContent = text;
        toastEl.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 3200);
    };

    const copyText = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            // clipboard API is unavailable on plain-http network addresses
            const box = el("textarea");
            box.value = text;
            box.style.cssText = "position:fixed;opacity:0";
            document.body.appendChild(box);
            box.select();
            let ok = false;
            try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
            box.remove();
            return ok;
        }
    };

    /* ---------- local media (never blocks joining) ---------- */

    const getMedia = async (constraints) => {
        try {
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            return null;
        }
    };

    const makeSilentAudio = () => {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const track = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
            track.enabled = false;
            return track;
        } catch (e) {
            return null;
        }
    };

    const makeBlankVideo = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#171b25";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.captureStream(1).getVideoTracks()[0];
    };

    const initMedia = async () => {
        silentAudio = makeSilentAudio();
        blankVideo = makeBlankVideo();

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            notice("Your browser blocks camera/mic on this address (needs https or localhost). You joined without them.");
        } else {
            let stream = await getMedia({ video: VIDEO, audio: AUDIO });
            if (!stream) {
                // One device missing or denied: keep whichever one works
                const audioOnly = await getMedia({ audio: AUDIO });
                const videoOnly = await getMedia({ video: VIDEO });
                stream = new MediaStream([
                    ...(audioOnly ? audioOnly.getTracks() : []),
                    ...(videoOnly ? videoOnly.getTracks() : []),
                ]);
            }
            realAudio = stream.getAudioTracks()[0] || null;
            realVideo = stream.getVideoTracks()[0] || null;
            if (!realAudio && !realVideo) {
                toast("Camera and mic are off. Allow them in the browser address bar, then use the Mic / Camera buttons.");
            }
        }

        localStream = new MediaStream([realAudio || silentAudio, screenTrack || realVideo || blankVideo].filter(Boolean));
        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
    };

    // Swap a track in the local preview and in every live call without renegotiating
    const setTrack = (kind, track) => {
        if (!track || !localStream) return;
        localStream.getTracks().filter((t) => t.kind === kind).forEach((t) => localStream.removeTrack(t));
        localStream.addTrack(track);
        calls.forEach((call) => {
            const pc = call.peerConnection;
            if (!pc) return;
            pc.getSenders().forEach((sender) => {
                if (sender.track && sender.track.kind === kind) sender.replaceTrack(track).catch(() => {});
            });
        });
    };
    const applyVideo = () => setTrack("video", screenTrack || realVideo || blankVideo);

    const micOn = () => !!realAudio && realAudio.enabled;
    const camOn = () => !!realVideo;

    const setIcon = (button, classes) => {
        const i = button.querySelector("i");
        if (i) i.className = classes;
    };

    const updateLocalUI = () => {
        const mic = micOn();
        const cam = camOn();
        const sharing = !!screenTrack;

        const micBtn = $("micBtn");
        micBtn.classList.toggle("danger", !mic);
        micBtn.setAttribute("aria-pressed", String(!mic));
        micBtn.setAttribute("aria-label", mic ? "Mute microphone" : "Unmute microphone");
        setIcon(micBtn, mic ? "fa-solid fa-microphone" : "fa-solid fa-microphone-slash");

        const camBtn = $("cameraBtn");
        camBtn.classList.toggle("danger", !cam);
        camBtn.setAttribute("aria-pressed", String(!cam));
        camBtn.setAttribute("aria-label", cam ? "Turn camera off" : "Turn camera on");
        setIcon(camBtn, cam ? "fa-solid fa-video" : "fa-solid fa-video-slash");

        $("shareBtn").classList.toggle("active", sharing);
        $("shareBtn").setAttribute("aria-label", sharing ? "Stop sharing" : "Share screen");

        localMicStatus.classList.toggle("muted", !mic);
        localMicStatus.title = mic ? "Microphone on" : "Microphone off";
        localMicStatus.replaceChildren(icon(mic ? "fa-solid fa-microphone" : "fa-solid fa-microphone-slash"));

        localPlaceholder.style.display = cam || sharing ? "none" : "flex";
        localVideo.classList.toggle("mirrored", cam && !sharing);

        if (joined) socket.emit("media-state", { mic, cam: cam || sharing });
        renderPeople();
    };

    const toggleMic = async () => {
        if (!realAudio) {
            const stream = await getMedia({ audio: AUDIO });
            if (!stream) return toast("Microphone unavailable. Allow it in the browser address bar.");
            realAudio = stream.getAudioTracks()[0];
            setTrack("audio", realAudio);
        } else {
            realAudio.enabled = !realAudio.enabled;
        }
        updateLocalUI();
    };

    const toggleCamera = async () => {
        if (realVideo) {
            realVideo.stop(); // actually release the camera so its light turns off
            realVideo = null;
        } else {
            const stream = await getMedia({ video: VIDEO });
            if (!stream) return toast("Camera unavailable. Allow it in the browser address bar.");
            realVideo = stream.getVideoTracks()[0];
        }
        applyVideo();
        updateLocalUI();
    };

    const stopShare = () => {
        if (!screenTrack) return;
        const track = screenTrack;
        screenTrack = null;
        track.onended = null;
        track.stop();
        applyVideo();
        updateLocalUI();
    };

    const toggleShare = async () => {
        if (screenTrack) return stopShare();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            return toast("Screen sharing isn't supported in this browser or address.");
        }
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            screenTrack = stream.getVideoTracks()[0];
            screenTrack.onended = stopShare;
            applyVideo();
            updateLocalUI();
            toast("You're sharing your screen");
        } catch (e) { /* cancelled */ }
    };

    /* ---------- tiles & participants ---------- */

    const layoutGrid = () => {
        const count = grid.children.length;
        if (window.innerWidth <= 850) return void (grid.style.gridTemplateColumns = "");
        const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
        grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    };

    const ensureTile = (peerId) => {
        let tile = tiles.get(peerId);
        if (tile) return tile;

        const video = el("video");
        video.autoplay = true;
        video.playsInline = true;

        const avatar = el("span", "person-avatar");
        const placeholder = el("div", "video-placeholder");
        placeholder.append(avatar, el("span", "", "Camera is off"));

        const nameEl = el("span");
        const mic = el("span", "tile-status");
        const label = el("div", "tile-bottom-label");
        label.append(nameEl, mic);

        const article = el("article", "video-tile");
        article.append(video, placeholder, label);
        grid.appendChild(article);

        tile = { el: article, video, placeholder, avatar, nameEl, mic };
        tiles.set(peerId, tile);
        layoutGrid();
        return tile;
    };

    const updateTile = (peerId) => {
        const info = roster.get(peerId);
        const tile = ensureTile(peerId);
        const name = info ? info.name : "Guest";
        tile.nameEl.textContent = name;
        tile.avatar.textContent = initial(name);
        tile.placeholder.style.display = info && info.cam ? "none" : "flex";
        const mic = !!(info && info.mic);
        tile.mic.classList.toggle("muted", !mic);
        tile.mic.replaceChildren(icon(mic ? "fa-solid fa-microphone" : "fa-solid fa-microphone-slash"));
    };

    const removeTile = (peerId) => {
        const tile = tiles.get(peerId);
        if (tile) tile.el.remove();
        tiles.delete(peerId);
        layoutGrid();
    };

    const findByUserId = (id) => [...roster.values()].find((p) => p.id === id);

    const updateCounts = () => {
        const total = roster.size + 1;
        $("participantCount").textContent = total;
        $("peopleTotal").textContent = total === 1 ? "1 participant" : `${total} participants`;
        if (roster.size === 0) notice("You're the only one here. Copy the invite link and send it to others.");
        else notice("");
    };

    const renderPeople = () => {
        const list = $("participantList");
        const rows = [{ name: `${myName} (You)`, mic: micOn() }, ...[...roster.values()].map((p) => ({ name: p.name, mic: p.mic }))];
        list.replaceChildren(...rows.map((p) => {
            const row = el("div", "participant-row");
            const details = el("div", "participant-details");
            details.append(el("strong", "", p.name), el("small", "", "In this meeting"));
            const audio = el("span", `participant-audio${p.mic ? "" : " muted"}`);
            audio.appendChild(icon(p.mic ? "fa-solid fa-microphone" : "fa-solid fa-microphone-slash"));
            row.append(el("span", "participant-avatar", initial(p.name)), details, audio);
            return row;
        }));
        updateCounts();
    };

    const addParticipant = (info) => {
        roster.set(info.peerId, { ...(roster.get(info.peerId) || {}), ...info });
        updateTile(info.peerId);
        renderPeople();
    };

    const removeParticipant = (peerId) => {
        const call = calls.get(peerId);
        if (call) call.close();
        calls.delete(peerId);
        roster.delete(peerId);
        removeTile(peerId);
        renderPeople();
    };

    /* ---------- calls (mesh: the newcomer calls everyone already in the room) ---------- */

    const setupCall = (call) => {
        calls.set(call.peer, call);
        call.on("stream", (remoteStream) => {
            const tile = ensureTile(call.peer);
            if (tile.video.srcObject !== remoteStream) {
                tile.video.srcObject = remoteStream;
                tile.video.play().catch(() => {});
            }
        });
        call.on("close", () => {
            if (calls.get(call.peer) === call) calls.delete(call.peer);
        });
        call.on("error", () => {});
    };

    const callPeer = (info) => {
        if (calls.has(info.peerId)) return;
        setupCall(peer.call(info.peerId, localStream, { metadata: { name: myName } }));
    };

    const createPeer = () => new Promise((resolve, reject) => {
        const secure = location.protocol === "https:";
        peer = new Peer(undefined, {
            host: location.hostname,
            port: Number(location.port) || (secure ? 443 : 80),
            path: "/peerjs",
            secure,
            config: {
                iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:19302" },
                ],
            },
        });
        peer.on("open", resolve);
        peer.on("call", (call) => {
            if (!roster.has(call.peer)) {
                addParticipant({ id: null, peerId: call.peer, name: (call.metadata && call.metadata.name) || "Guest", mic: false, cam: false });
            }
            call.answer(localStream);
            setupCall(call);
        });
        peer.on("disconnected", () => peer.reconnect());
        peer.on("error", (err) => {
            if (!peer.id) return reject(err);
            if (err.type !== "peer-unavailable") console.warn("Peer error:", err);
        });
    });

    /* ---------- chat, notes, reactions ---------- */

    const chatBox = $("messageadd");
    const chatInput = $("chat_message");

    const addChatMessage = ({ id, name, text, time }) => {
        const empty = $("chatEmpty");
        if (empty) empty.remove();
        const own = id === selfId;
        const meta = el("div", "message-meta");
        meta.append(
            el("span", "message-name", own ? "You" : name),
            el("span", "message-time", new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
        );
        const wrap = el("div", `chat-message${own ? " own" : ""}`);
        wrap.append(meta, el("div", "message-bubble", text));
        chatBox.appendChild(wrap);
        chatBox.scrollTop = chatBox.scrollHeight;
        if (!own && panel !== "chat") toast(`${name}: ${text.length > 70 ? text.slice(0, 70) + "…" : text}`);
    };

    const sendChat = () => {
        const text = chatInput.value.trim();
        if (!text) return;
        socket.emit("chat", text);
        chatInput.value = "";
    };

    $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });

    const notes = $("sharedNotes");
    const notesStatus = $("notesStatus");
    let notesTimer;
    notes.addEventListener("input", () => {
        notesStatus.textContent = "Saving…";
        clearTimeout(notesTimer);
        notesTimer = setTimeout(() => {
            socket.emit("notes", notes.value);
            notesStatus.textContent = "Saved";
        }, 350);
    });

    const showReaction = (emoji, tileEl) => {
        if (!tileEl) return;
        const burst = el("span", "tile-reaction", emoji);
        tileEl.appendChild(burst);
        setTimeout(() => burst.remove(), 900);
    };

    const picker = $("reactionPicker");
    $("reactionBtn").addEventListener("click", (e) => { e.stopPropagation(); picker.classList.toggle("hidden"); });
    picker.addEventListener("click", (e) => {
        const button = e.target.closest("[data-reaction]");
        if (!button) return;
        socket.emit("reaction", button.dataset.reaction);
        picker.classList.add("hidden");
    });
    document.addEventListener("click", () => picker.classList.add("hidden"));

    /* ---------- side panel ---------- */

    const PANELS = {
        chat: { btn: "chatBtn", view: "chatView", title: "Meeting chat", sub: "Messages are shared with the room." },
        people: { btn: "peopleBtn", view: "peopleView", title: "People", sub: "Everyone in this meeting." },
        notes: { btn: "notesBtn", view: "notesView", title: "Shared notes", sub: "Edits sync with the whole room." },
    };

    const showPanel = (name) => {
        panel = name;
        workspace.classList.toggle("panel-closed", !name);
        sidePanel.style.display = name ? "" : "none";
        Object.entries(PANELS).forEach(([key, cfg]) => {
            const active = key === name;
            $(cfg.view).classList.toggle("hidden", !active);
            $(cfg.btn).classList.toggle("active", active);
            $(cfg.btn).setAttribute("aria-pressed", String(active));
        });
        if (name) {
            $("panelTitle").textContent = PANELS[name].title;
            $("panelSubtitle").textContent = PANELS[name].sub;
            if (name === "chat") chatBox.scrollTop = chatBox.scrollHeight;
        }
    };

    Object.entries(PANELS).forEach(([key, cfg]) => {
        $(cfg.btn).addEventListener("click", () => showPanel(panel === key ? null : key));
    });
    $("closePanelBtn").addEventListener("click", () => showPanel(null));

    /* ---------- invite ---------- */

    let inviteBase = location.origin;
    const inviteLink = () => `${inviteBase}/join/${roomId}`;

    const loadInviteBase = async () => {
        // On localhost the link would only work on this PC, so use the PC's network address instead
        if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return;
        try {
            const info = await (await fetch("/api/info")).json();
            if (info.lan && info.lan.length) {
                inviteBase = `${location.protocol}//${info.lan[0]}${location.port ? ":" + location.port : ""}`;
            }
        } catch (e) { /* keep origin */ }
    };

    const copyInvite = async () => {
        const link = inviteLink();
        const ok = await copyText(link);
        toast(ok ? "Invite link copied. Send it to anyone on your network." : `Copy this link: ${link}`);
    };
    $("copyRoomBtn").addEventListener("click", copyInvite);
    $("inviteBtn").addEventListener("click", copyInvite);

    /* ---------- toolbar, leave, clock ---------- */

    $("micBtn").addEventListener("click", toggleMic);
    $("cameraBtn").addEventListener("click", toggleCamera);
    $("shareBtn").addEventListener("click", toggleShare);

    const leave = () => {
        stopShare();
        [realAudio, realVideo].forEach((t) => t && t.stop());
        calls.forEach((c) => c.close());
        if (peer) peer.destroy();
        socket.disconnect();
        location.href = "/";
    };
    $("leaveBtn").addEventListener("click", leave);
    window.addEventListener("beforeunload", () => { if (peer) peer.destroy(); });
    window.addEventListener("resize", layoutGrid);

    const startedAt = Date.now();
    setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        const pad = (n) => String(n).padStart(2, "0");
        const h = Math.floor(s / 3600);
        $("meetingClock").textContent = `${h ? pad(h) + ":" : ""}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    }, 1000);

    /* ---------- socket events ---------- */

    const setStatus = (online) => {
        const label = $("connectionStatus");
        label.classList.toggle("offline", !online);
        label.replaceChildren(el("span", "status-dot"), document.createTextNode(online ? " Connected" : " Reconnecting…"));
    };

    socket.on("connect", () => {
        // A fresh socket has no room membership on the server, so rejoin cleanly
        if (joined) return location.reload();
        setStatus(true);
    });
    socket.on("disconnect", () => setStatus(false));

    socket.on("user-joined", (info) => {
        addParticipant(info);
        toast(`${info.name} joined`);
    });
    socket.on("user-left", ({ peerId, name }) => {
        removeParticipant(peerId);
        toast(`${name} left`);
    });
    socket.on("media-state", ({ id, mic, cam }) => {
        const p = findByUserId(id);
        if (!p) return;
        p.mic = mic;
        p.cam = cam;
        updateTile(p.peerId);
        renderPeople();
    });
    socket.on("chat", addChatMessage);
    socket.on("notes", (text) => { if (notes.value !== text) notes.value = text; });
    socket.on("reaction", ({ id, emoji }) => {
        if (id === selfId) return showReaction(emoji, $("localTile"));
        const p = findByUserId(id);
        showReaction(emoji, p && tiles.get(p.peerId) && tiles.get(p.peerId).el);
    });

    /* ---------- start ---------- */

    const start = async () => {
        $("roomCode").textContent = roomId;
        $("roomCode").title = roomId;
        $("roomCode").style.cssText = "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        $("profileAvatar").textContent = initial(myName);
        $("localInitial").textContent = initial(myName);
        $("localName").textContent = myName;
        $("meetingSubtitle").textContent = `Joined as ${myName}`;
        showPanel("chat");

        await initMedia();
        updateLocalUI();
        await loadInviteBase();

        try {
            await createPeer();
        } catch (e) {
            notice("Couldn't reach the call server. Refresh the page.");
            return;
        }

        socket.emit("join-room", roomId, peer.id, myName, (res) => {
            if (!res || res.error) {
                alert((res && res.error) || "Could not join this meeting.");
                return void (location.href = "/");
            }
            joined = true;
            selfId = res.selfId;
            notes.value = res.notes || "";
            res.participants.forEach((p) => { addParticipant(p); callPeer(p); });
            socket.emit("media-state", { mic: micOn(), cam: camOn() || !!screenTrack });
            renderPeople();
            setStatus(true);
        });
    };

    start();
})();
