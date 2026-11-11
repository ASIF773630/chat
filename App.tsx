import React, { useEffect, useRef, useState, type ComponentType } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  type Permission,
  PermissionsAndroid,
  Platform,
  ScrollView,
  type ScrollViewInstance,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type {
  MediaStream,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCVideoViewProps,
} from "react-native-webrtc";

const countries = ["Worldwide", "India", "UAE", "USA", "UK"];
const interests = ["Technology", "Coding", "Music", "Sports", "Travel", "Gaming"];
const defaultServerUrl =
  Platform.OS === "android" ? "ws://10.0.2.2:3001" : "ws://localhost:3001";

type CallMode = "audio" | "video";
type ChatMessage = { id: string; text: string; mine: boolean };
type SessionDescriptionData = { sdp: string; type: string | null };
type PeerConnectionEvents = {
  addEventListener(
    type: "icecandidate",
    listener: (event: { candidate: RTCIceCandidate | null }) => void,
  ): void;
  addEventListener(
    type: "track",
    listener: (event: { streams: MediaStream[] }) => void,
  ): void;
  addEventListener(type: "connectionstatechange", listener: () => void): void;
};
type SignalMessage =
  | { kind: "offer"; mode: CallMode; description: SessionDescriptionData }
  | { kind: "answer"; description: SessionDescriptionData }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "hangup" };
type RTCModule = typeof import("react-native-webrtc");

function sendJson(socket: WebSocket | null, data: object) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

async function loadRTCModule(): Promise<RTCModule> {
  if (Platform.OS === "web") {
    throw new Error("Voice and video calls require the Android or iOS app.");
  }
  return import("react-native-webrtc");
}

export default function App() {
  const [country, setCountry] = useState("Worldwide");
  const [selected, setSelected] = useState<string[]>([]);
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [status, setStatus] = useState<"idle" | "searching" | "chat">("idle");
  const [peerId, setPeerId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [callMode, setCallMode] = useState<CallMode | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [RTCVideoView, setRTCVideoView] =
    useState<ComponentType<RTCVideoViewProps> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const rtcModuleRef = useRef<RTCModule | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const scrollRef = useRef<ScrollViewInstance | null>(null);

  const toggleInterest = (item: string) => {
    setSelected((previous) =>
      previous.includes(item)
        ? previous.filter((interest) => interest !== item)
        : [...previous, item],
    );
  };

  const sendSignal = (signal: SignalMessage) => {
    sendJson(socketRef.current, { type: "signal", signal });
  };

  const stopCall = (notifyPeer = false) => {
    if (notifyPeer) sendSignal({ kind: "hangup" });
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    pendingCandidatesRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setCallMode(null);
  };

  const endChat = (notifyServer = true) => {
    stopCall(true);
    const socket = socketRef.current;
    socketRef.current = null;
    if (notifyServer) sendJson(socket, { type: "leave" });
    socket?.close();
    setStatus("idle");
    setPeerId("");
    setMessages([]);
  };

  const loadRTC = async () => {
    if (!rtcModuleRef.current) {
      rtcModuleRef.current = await loadRTCModule();
      setRTCVideoView(() => rtcModuleRef.current!.RTCView);
    }
    return rtcModuleRef.current;
  };

  const createPeerConnection = async () => {
    if (peerConnectionRef.current) return peerConnectionRef.current;
    const rtc = await loadRTC();
    const connection = new rtc.RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const events = connection as RTCPeerConnection & PeerConnectionEvents;
    events.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        sendSignal({ kind: "ice", candidate: event.candidate.toJSON() });
      }
    });
    events.addEventListener("track", (event) => {
      if (event.streams[0]) setRemoteStream(event.streams[0]);
    });
    events.addEventListener("connectionstatechange", () => {
      if (
        connection.connectionState === "failed" ||
        connection.connectionState === "closed"
      ) {
        stopCall();
      }
    });
    peerConnectionRef.current = connection;
    return connection;
  };

  const acquireMedia = async (mode: CallMode) => {
    if (Platform.OS === "android") {
      const permissions: Permission[] = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
      if (mode === "video") permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
      const results = await PermissionsAndroid.requestMultiple(permissions);
      if (Object.values(results).some((result) => result !== "granted")) {
        throw new Error("Camera and microphone permissions are required.");
      }
    }

    const rtc = await loadRTC();
    if (!localStreamRef.current) {
      const stream = await rtc.mediaDevices.getUserMedia({
        audio: true,
        video: mode === "video" ? { facingMode: "user" } : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
    }
    setCallMode(mode);
    const connection = await createPeerConnection();
    const existingTrackIds = new Set(
      connection.getSenders().map((sender) => sender.track?.id),
    );
    localStreamRef.current?.getTracks().forEach((track) => {
      if (!existingTrackIds.has(track.id)) connection.addTrack(track, localStreamRef.current!);
    });
    return connection;
  };

  const flushPendingCandidates = async (connection: RTCPeerConnection) => {
    const candidates = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of candidates) {
      const rtc = await loadRTC();
      await connection.addIceCandidate(new rtc.RTCIceCandidate(candidate));
    }
  };

  const handleSignal = async (signal: SignalMessage) => {
    try {
      if (signal.kind === "hangup") {
        stopCall();
        return;
      }
      if (signal.kind === "offer") {
        const connection = await acquireMedia(signal.mode);
        const rtc = await loadRTC();
        await connection.setRemoteDescription(
          new rtc.RTCSessionDescription(signal.description),
        );
        await flushPendingCandidates(connection);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        sendSignal({
          kind: "answer",
          description: { sdp: answer.sdp, type: answer.type },
        });
        return;
      }

      if (signal.kind === "answer") {
        const connection = peerConnectionRef.current;
        if (!connection) return;
        await connection.setRemoteDescription(
          new (await loadRTC()).RTCSessionDescription(signal.description),
        );
        await flushPendingCandidates(connection);
      } else if (signal.kind === "ice") {
        const connection = peerConnectionRef.current;
        if (connection?.remoteDescription) {
          await connection.addIceCandidate(
            new (await loadRTC()).RTCIceCandidate(signal.candidate),
          );
        } else {
          pendingCandidatesRef.current.push(signal.candidate);
        }
      }
    } catch (reason) {
      stopCall();
      setError(reason instanceof Error ? reason.message : "Could not start the call.");
    }
  };

  const startCall = async (mode: CallMode) => {
    try {
      const connection = await acquireMedia(mode);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      sendSignal({
        kind: "offer",
        mode,
        description: { sdp: offer.sdp, type: offer.type },
      });
    } catch (reason) {
      stopCall();
      setError(reason instanceof Error ? reason.message : "Could not start the call.");
    }
  };

  const startSearch = () => {
    setError("");
    let socket: WebSocket;
    try {
      socket = new WebSocket(serverUrl.trim());
    } catch {
      setError("Enter a valid WebSocket URL, such as ws://192.168.1.5:3001.");
      return;
    }

    socketRef.current = socket;
    setStatus("searching");
    socket.onopen = () => {
      sendJson(socket, { type: "join", country, interests: selected });
    };
    socket.onmessage = (event) => {
      let data: { type?: string; [key: string]: unknown };
      try {
        data = JSON.parse(String(event.data));
      } catch {
        setError("The match server sent an invalid response.");
        return;
      }

      if (data.type === "waiting") {
        setStatus("searching");
      } else if (data.type === "matched") {
        setPeerId(String(data.peerId || ""));
        setMessages([]);
        setStatus("chat");
      } else if (data.type === "chat" && typeof data.text === "string") {
        const text = data.text;
        setMessages((previous) => [
          ...previous,
          { id: `${Date.now()}-${Math.random()}`, text, mine: false },
        ]);
      } else if (data.type === "signal" && data.signal) {
        void handleSignal(data.signal as SignalMessage);
      } else if (data.type === "peer_left") {
        stopCall();
        setStatus("idle");
        setPeerId("");
        setError("The other person left the chat.");
        socketRef.current = null;
        socket.close();
      } else if (data.type === "error") {
        setError(String(data.message || "The match server reported an error."));
      }
    };
    socket.onerror = () => {
      setError("Could not reach the match server. Check its URL and that it is running.");
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        stopCall();
        setStatus("idle");
        setPeerId("");
      }
    };
  };

  const sendMessage = () => {
    const text = draft.trim();
    if (!text || text.length > 2000) return;
    const id = `${Date.now()}-${Math.random()}`;
    sendJson(socketRef.current, { type: "chat", text });
    setMessages((previous) => [...previous, { id, text, mine: true }]);
    setDraft("");
  };

  const reportAndLeave = () => {
    Alert.alert("Report this person?", "The report is sent to the match server without saving chat messages.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Report and leave",
        style: "destructive",
        onPress: () => {
          sendJson(socketRef.current, { type: "report" });
          endChat();
        },
      },
    ]);
  };

  useEffect(
    () => () => {
      stopCall(true);
      socketRef.current?.close();
    },
    [],
  );

  if (status === "chat") {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" />
        <View style={styles.chatHeader}>
          <View>
            <Text style={styles.logo}>ConnectX.</Text>
            <Text style={styles.online}>● Connected</Text>
          </View>
          <TouchableOpacity style={styles.leaveButton} onPress={() => endChat()}>
            <Text style={styles.leaveText}>Leave</Text>
          </TouchableOpacity>
        </View>

        {(remoteStream || localStream) && (
          <View style={styles.videoArea}>
            {remoteStream && RTCVideoView ? (
              <RTCVideoView streamURL={remoteStream.toURL()} style={styles.remoteVideo} objectFit="cover" />
            ) : (
              <View style={styles.videoPlaceholder}>
                <Text style={styles.mutedText}>Waiting for the other person…</Text>
              </View>
            )}
            {callMode === "video" && localStream && RTCVideoView && (
              <RTCVideoView streamURL={localStream.toURL()} style={styles.localVideo} objectFit="cover" mirror />
            )}
            {callMode === "audio" && (
              <Text style={styles.mutedText}>Voice call active</Text>
            )}
          </View>
        )}

        <ScrollView
          ref={scrollRef}
          style={styles.messageList}
          contentContainerStyle={styles.messageContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 && (
            <Text style={styles.mutedText}>You’re connected. Say hello!</Text>
          )}
          {messages.map((message) => (
            <View
              key={message.id}
              style={[styles.messageBubble, message.mine ? styles.myMessage : styles.theirMessage]}
            >
              <Text style={styles.messageText}>{message.text}</Text>
            </View>
          ))}
        </ScrollView>

        {Platform.OS === "web" ? (
          <Text style={styles.hint}>Voice and video calls are available in the Android/iOS development build.</Text>
        ) : (
          <View style={styles.callActions}>
            <TouchableOpacity
              style={[styles.secondaryButton, callMode && styles.disabledButton]}
              disabled={!!callMode}
              onPress={() => void startCall("audio")}
            >
              <Text style={styles.secondaryButtonText}>Voice call</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryButton, callMode && styles.disabledButton]}
              disabled={!!callMode}
              onPress={() => void startCall("video")}
            >
              <Text style={styles.secondaryButtonText}>Video call</Text>
            </TouchableOpacity>
            {callMode && (
              <TouchableOpacity style={styles.leaveButton} onPress={() => stopCall(true)}>
                <Text style={styles.leaveText}>End call</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Write a message…"
            placeholderTextColor="#8290A4"
            style={styles.messageInput}
            maxLength={2000}
            onSubmitEditing={sendMessage}
            returnKeyType="send"
          />
          <TouchableOpacity style={styles.sendButton} onPress={sendMessage}>
            <Text style={styles.sendText}>Send</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.reportButton} onPress={reportAndLeave}>
          <Text style={styles.cancelText}>Report and leave</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle="light-content" />
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.logo}>ConnectX.</Text>
          <Text style={styles.online}>● Ready</Text>
        </View>
        <View style={styles.hero}>
          <Text style={styles.globe}>🌍</Text>
          <Text style={styles.title}>Meet the World.</Text>
          <Text style={styles.subtitle}>
            Connect with new people, share stories and make friends around the world.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.heading}>Match server</Text>
          <TextInput
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="ws://your-computer-ip:3001"
            placeholderTextColor="#8290A4"
            style={styles.serverInput}
          />
          <Text style={styles.hint}>
            Use your computer’s LAN IP on a phone. Public servers should use wss://.
          </Text>

          <Text style={styles.heading}>Choose country</Text>
          <View style={styles.chips}>
            {countries.map((item) => (
              <TouchableOpacity
                key={item}
                style={[styles.chip, styles.chipSpacing, country === item ? styles.activeChip : undefined]}
                onPress={() => setCountry(item)}
              >
                <Text style={[styles.chipText, country === item ? styles.activeText : undefined]}>
                  {item}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.heading}>Your interests</Text>
          <View style={styles.chips}>
            {interests.map((item) => (
              <TouchableOpacity
                key={item}
                style={[
                  styles.chip,
                  styles.chipSpacing,
                  selected.includes(item) ? styles.activeChip : undefined,
                ]}
                onPress={() => toggleInterest(item)}
              >
                <Text style={[styles.chipText, selected.includes(item) ? styles.activeText : undefined]}>
                  {item}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.startButton, status === "searching" && styles.disabledButton]}
          onPress={status === "searching" ? () => endChat() : startSearch}
        >
          {status === "searching" ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : null}
          <Text style={styles.startText}>
            {status === "searching" ? "Cancel search" : "⚡ Find a random chat"}
          </Text>
        </TouchableOpacity>
        {status === "searching" && (
          <Text style={styles.searchingText}>Looking for someone with a compatible match…</Text>
        )}

        <Text style={styles.footer}>
          Text, voice and video • Chats are not stored by this server
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#090E18", paddingHorizontal: 20, paddingTop: 45 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  chatHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#202B3B",
  },
  logo: { color: "#FFFFFF", fontSize: 25, fontWeight: "bold" },
  online: { color: "#22C55E", fontSize: 13, marginTop: 4 },
  hero: { alignItems: "center", marginTop: 35, marginBottom: 25 },
  globe: { fontSize: 58 },
  title: { color: "#FFFFFF", fontSize: 29, fontWeight: "bold", marginTop: 12 },
  subtitle: { color: "#929DB0", fontSize: 14, textAlign: "center", marginTop: 10, lineHeight: 22 },
  card: { backgroundColor: "#141D2B", padding: 18, borderRadius: 18 },
  heading: { color: "#FFFFFF", fontSize: 16, fontWeight: "bold", marginTop: 10, marginBottom: 12 },
  serverInput: {
    color: "#FFFFFF",
    backgroundColor: "#202B3B",
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
  },
  hint: { color: "#929DB0", fontSize: 12, marginTop: 8, lineHeight: 17 },
  chips: { flexDirection: "row", flexWrap: "wrap", marginBottom: 12 },
  chip: { backgroundColor: "#202B3B", borderRadius: 20, paddingVertical: 9, paddingHorizontal: 13 },
  chipSpacing: { marginRight: 8, marginBottom: 8 },
  activeChip: { backgroundColor: "#2563EB" },
  chipText: { color: "#B7C2D1", fontSize: 13 },
  activeText: { color: "#FFFFFF", fontWeight: "bold" },
  startButton: {
    backgroundColor: "#2563EB",
    padding: 17,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    marginTop: 18,
  },
  startText: { color: "#FFFFFF", fontWeight: "bold", fontSize: 16, marginLeft: 8 },
  disabledButton: { opacity: 0.7 },
  searchingText: { color: "#B7C2D1", textAlign: "center", marginTop: 14 },
  error: { color: "#FCA5A5", marginTop: 14, lineHeight: 20 },
  footer: { color: "#8290A4", textAlign: "center", marginTop: 28, marginBottom: 28, lineHeight: 19 },
  chatActions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  leaveButton: { backgroundColor: "#7F1D1D", paddingVertical: 10, paddingHorizontal: 15, borderRadius: 10 },
  leaveText: { color: "#FFFFFF", fontWeight: "bold" },
  messageList: { flex: 1, marginTop: 14 },
  messageContent: { flexGrow: 1, justifyContent: "flex-end", paddingVertical: 12 },
  mutedText: { color: "#929DB0", textAlign: "center", padding: 12 },
  messageBubble: { maxWidth: "82%", padding: 12, borderRadius: 14, marginBottom: 10 },
  myMessage: { alignSelf: "flex-end", backgroundColor: "#2563EB" },
  theirMessage: { alignSelf: "flex-start", backgroundColor: "#202B3B" },
  messageText: { color: "#FFFFFF", fontSize: 15, lineHeight: 20 },
  callActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginBottom: 10 },
  secondaryButton: { backgroundColor: "#202B3B", padding: 10, borderRadius: 10, marginRight: 8, marginBottom: 6 },
  secondaryButtonText: { color: "#FFFFFF", fontWeight: "600" },
  composer: { flexDirection: "row", alignItems: "center", paddingTop: 8, borderTopWidth: 1, borderTopColor: "#202B3B" },
  messageInput: { flex: 1, backgroundColor: "#141D2B", color: "#FFFFFF", borderRadius: 12, padding: 12, marginRight: 8 },
  sendButton: { backgroundColor: "#2563EB", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14 },
  sendText: { color: "#FFFFFF", fontWeight: "bold" },
  reportButton: { alignSelf: "center", padding: 10 },
  cancelText: { color: "#F87171" },
  videoArea: { height: 220, marginTop: 12, borderRadius: 14, overflow: "hidden", backgroundColor: "#141D2B", justifyContent: "center" },
  remoteVideo: { width: "100%", height: "100%" },
  localVideo: { position: "absolute", right: 10, top: 10, width: 90, height: 130, borderRadius: 10 },
  videoPlaceholder: { flex: 1, justifyContent: "center", alignItems: "center" },
});
