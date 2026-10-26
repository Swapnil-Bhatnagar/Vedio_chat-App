const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { ExpressPeerServer } = require("peer");

const PORT = process.env.PORT || 3030;
const ROOM_LIMIT = 12;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_NOTES_LENGTH = 15000;
const MAX_NAME_LENGTH = 60;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REACTIONS = ["👍", "👏", "❤️", "😂", "🎉", "🙌"];

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);
const peerServer = ExpressPeerServer(server, {});

app.set("view engine", "ejs");
app.use("/public", express.static(path.join(__dirname, "static")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/peerjs", peerServer);

// rooms: roomId -> { participants: Map(socketId -> {peerId, name, mic, cam}), notes }
const rooms = new Map();

const cleanName = (name) =>
    String(name || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) || "Guest";

// Lets the host build an invite link other devices can actually reach (localhost is only valid on this PC)
const lanAddresses = () => {
    const skip = /vethernet|virtualbox|vmware|wsl|hyper-v|docker|loopback/i;
    const found = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (skip.test(name)) continue;
        for (const net of list || []) {
            if ((net.family === "IPv4" || net.family === 4) && !net.internal) found.push(net.address);
        }
    }
    return found.sort((a, b) => Number(b.startsWith("192.168.")) - Number(a.startsWith("192.168.")));
};

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "static", "index.html"));
});

app.get("/api/info", (req, res) => {
    res.json({ lan: lanAddresses() });
});

// "New meeting" form: create a unique room and keep the host's name
app.get("/join", (req, res) => {
    const name = encodeURIComponent(cleanName(req.query.name));
    res.redirect(`/join/${uuidv4()}?name=${name}`);
});

// "Join a room" form: accepts either a bare meeting ID or a full invite link
app.get("/joinold", (req, res) => {
    const raw = String(req.query.meeting_id || "").trim();
    const id = raw.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
    if (!ROOM_ID_PATTERN.test(id)) return res.redirect("/");
    res.redirect(`/join/${id}?name=${encodeURIComponent(cleanName(req.query.name))}`);
});

app.get("/join/:rooms", (req, res) => {
    const roomid = req.params.rooms;
    if (!ROOM_ID_PATTERN.test(roomid)) return res.redirect("/");
    // Someone opened an invite link directly: ask for their name first
    if (!String(req.query.name || "").trim()) return res.redirect(`/?room=${encodeURIComponent(roomid)}`);
    res.render("room", { roomid, Myname: cleanName(req.query.name) });
});

const publicInfo = (socketId, p) => ({ id: socketId, peerId: p.peerId, name: p.name, mic: p.mic, cam: p.cam });

io.on("connection", (socket) => {
    let roomId = null;

    socket.on("join-room", (room, peerId, name, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        if (roomId) return reply({ error: "Already joined" });
        if (!ROOM_ID_PATTERN.test(String(room)) || typeof peerId !== "string" || !peerId) {
            return reply({ error: "Invalid room" });
        }
        let state = rooms.get(room);
        if (!state) {
            state = { participants: new Map(), notes: "" };
            rooms.set(room, state);
        }
        if (state.participants.size >= ROOM_LIMIT) return reply({ error: "This room is full" });

        const me = { peerId, name: cleanName(name), mic: false, cam: false };
        const others = [...state.participants].map(([id, p]) => publicInfo(id, p));
        state.participants.set(socket.id, me);
        roomId = room;
        socket.join(room);
        socket.to(room).emit("user-joined", publicInfo(socket.id, me));
        reply({ ok: true, selfId: socket.id, participants: others, notes: state.notes });
    });

    const mine = () => rooms.get(roomId)?.participants.get(socket.id);

    socket.on("media-state", (s) => {
        const me = mine();
        if (!me || !s) return;
        me.mic = !!s.mic;
        me.cam = !!s.cam;
        socket.to(roomId).emit("media-state", { id: socket.id, mic: me.mic, cam: me.cam });
    });

    socket.on("chat", (text) => {
        const me = mine();
        const message = String(text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
        if (!me || !message) return;
        io.to(roomId).emit("chat", { id: socket.id, name: me.name, text: message, time: Date.now() });
    });

    socket.on("notes", (text) => {
        const state = rooms.get(roomId);
        if (!state || !mine()) return;
        state.notes = String(text || "").slice(0, MAX_NOTES_LENGTH);
        socket.to(roomId).emit("notes", state.notes);
    });

    socket.on("reaction", (emoji) => {
        if (!mine() || !REACTIONS.includes(emoji)) return;
        io.to(roomId).emit("reaction", { id: socket.id, emoji });
    });

    socket.on("disconnect", () => {
        const state = rooms.get(roomId);
        const me = state?.participants.get(socket.id);
        if (!me) return;
        state.participants.delete(socket.id);
        socket.to(roomId).emit("user-left", { id: socket.id, peerId: me.peerId, name: me.name });
        if (state.participants.size === 0) rooms.delete(roomId);
    });
});

server.listen(PORT, () => {
    console.log(`MeetSpace running:\n  This PC:  http://localhost:${PORT}`);
    lanAddresses().forEach((ip) => console.log(`  Network:  http://${ip}:${PORT}`));
});
