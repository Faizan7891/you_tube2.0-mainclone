import { useRouter } from "next/router";
import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useUser } from "@/lib/AuthContext";

const SERVER_URL = typeof window !== 'undefined' && window.location.hostname !== 'localhost' 
  ? `http://${window.location.hostname}:5000` 
  : "http://localhost:5000";

// TASK 6 - Security / participant limits
const MAX_PARTICIPANTS = 4;
const MEETING_TOKEN_KEY = "video-call-meeting-token";

const getMeetingToken = (roomId: string): string => {
  if (typeof window === "undefined" || !roomId) return "";
  const storageKey = `${MEETING_TOKEN_KEY}:${roomId}`;
  let token = sessionStorage.getItem(storageKey);
  if (!token) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem(storageKey, token);
  }
  return token;
};

const formatCallDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
};

export default function VideoCall() {
  const router = useRouter();
  const { user } = useUser();

  const localVideoRef = useRef<HTMLVideoElement>(null);

  

  const socketRef = useRef<Socket | null>(null);

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteSocketIdRef = useRef<string | null>(null);

  

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const manuallyLeavingRef = useRef(false);
  const iceRestartingRef = useRef(false);

  const [roomId, setRoomId] = useState("");

  const [status, setStatus] = useState("Starting camera...");

  const [error, setError] = useState("");

  const [micEnabled, setMicEnabled] = useState(true);

  const [cameraEnabled, setCameraEnabled] = useState(true);

  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const screenStreamRef = useRef<MediaStream | null>(null);

  const [showParticipants, setShowParticipants] = useState(false);
  const [participants, setParticipants] = useState<{ socketId: string; userName: string }[]>([]);

  const [showChat, setShowChat] = useState(false);

  const [handRaised, setHandRaised] = useState(false);

  const [raisedHands, setRaisedHands] = useState<string[]>([]);
  const [remoteHandRaised, setRemoteHandRaised] = useState<Record<string, boolean>>({});

  const [remoteMicEnabled, setRemoteMicEnabled] = useState<Record<string, boolean>>({});
  const [remoteCameraEnabled, setRemoteCameraEnabled] = useState<Record<string, boolean>>({});
  const [isRemoteSpeaking, setIsRemoteSpeaking] = useState<Record<string, boolean>>({});
  const [connectionQuality, setConnectionQuality] = useState("Good");
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isRestoringCall, setIsRestoringCall] = useState(false);
  const restoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasConnectedRef = useRef(false);

  // BATCH 4-7 STATE
  const [viewMode, setViewMode] = useState<"grid" | "speaker">("grid");
  const [pinnedParticipant, setPinnedParticipant] = useState<"local" | "remote" | string>("remote");
  const [isLocalFullscreen, setIsLocalFullscreen] = useState(false);
  const [isRemoteFullscreen, setIsRemoteFullscreen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [lastReadChatCount, setLastReadChatCount] = useState(0);
  const [showMeetingSettings, setShowMeetingSettings] = useState(false);
  const [waitingRoomEnabled, setWaitingRoomEnabled] = useState(false);
  const [muteAllRequested, setMuteAllRequested] = useState(false);
  const [meetingToken, setMeetingToken] = useState("");
  const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);

  const toggleRecording = () => {
    if (!isHost) return;

    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    // Try to get a combined stream
    const localStream = localStreamRef.current;
    if (!localStream) return;

    try {
      const stream = new MediaStream([...localStream.getTracks()]);
      Object.values(remoteStreams).forEach(remoteStream => {
        if (remoteStream) {
          remoteStream.getAudioTracks().forEach((track) => stream.addTrack(track));
        }
      });

      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = `recording-${roomId}-${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
        recordedChunksRef.current = [];
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      console.error("Recording error:", err);
      setError("Failed to start recording.");
    }
  };

  // ========================================================
  // HOST MODERATION STATE
  // ========================================================

  const [isHost, setIsHost] = useState(false);
  const [isCoHost, setIsCoHost] = useState(false);
  const [meetingLocked, setMeetingLocked] = useState(false);
  const [chatAllowed, setChatAllowed] = useState(true);
  const [screenShareAllowed, setScreenShareAllowed] = useState(true);

  const [chatMessage, setChatMessage] = useState("");
  const [callDuration, setCallDuration] = useState(0);

  const [chatMessages, setChatMessages] = useState<
    {
      sender: string;
      message: string;
      file?: { data: string; name: string; type: string } | null;
      timestamp: number;
    }[]
  >([]);
  const [chatFile, setChatFile] = useState<{ data: string; name: string; type: string } | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert("File size must be less than 2MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setChatFile({
          data: event.target.result as string,
          name: file.name,
          type: file.type
        });
      }
    };
    reader.readAsDataURL(file);
  };

  // ========================================================
  // GET ROOM ID
  // ========================================================

  useEffect(() => {
    if (!router.isReady) return;

    let id = "";

    if (typeof router.query.roomId === "string") {
      id = router.query.roomId;
    }

    // Fallback: get room ID directly from URL
    if (!id && router.asPath) {
      const parts = router.asPath.split("?")[0].split("/").filter(Boolean);

      const callIndex = parts.indexOf("call");

      if (callIndex !== -1 && parts[callIndex + 1]) {
        id = parts[callIndex + 1];
      }
    }

    if (id) {
      console.log("Room ID:", id);

      setRoomId(id);
    }
  }, [router.isReady, router.query.roomId, router.asPath]);

  // ========================================================
  // TASK 6 - SECURE MEETING TOKEN
  // ========================================================

  useEffect(() => {
    if (!roomId || typeof window === "undefined") return;
    setMeetingToken(getMeetingToken(roomId));
  }, [roomId]);

  // ========================================================
  // CREATE PEER
  // ========================================================

  const createPeer = useCallback((targetId: string, createOffer: boolean) => {
    if (peersRef.current.has(targetId)) {
      return peersRef.current.get(targetId)!;
    }

    const peer = new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302",
        },
        {
          urls: "stun:stun1.l.google.com:19302",
        },
      ],

    });

    peer.oniceconnectionstatechange = async () => {
      const state = peer.iceConnectionState;
      console.log("ICE connection state:", state);

      if (state === "connected" || state === "completed") {
        setConnectionQuality("Good");
        setStatus("Connected");
        setIsReconnecting(false);
        setIsRestoringCall(false);
        wasConnectedRef.current = true;
        reconnectAttemptsRef.current = 0;
        iceRestartingRef.current = false;

        // Restore bandwidth
        try {
          const videoSender = peer.getSenders().find(s => s.track?.kind === "video");
          if (videoSender) {
            const params = videoSender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
              params.encodings[0].maxBitrate = 1500000; // 1.5 Mbps
              videoSender.setParameters(params);
            }
          }
        } catch (e) {
          console.log("Failed to restore bandwidth", e);
        }

        return;
      }

      if (state === "checking") {
        setConnectionQuality("Fair");
        setStatus("Connecting...");
        setIsReconnecting(true);

        // Adapt to low bandwidth
        try {
          const videoSender = peer.getSenders().find(s => s.track?.kind === "video");
          if (videoSender) {
            const params = videoSender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
              params.encodings[0].maxBitrate = 150000; // 150 kbps
              videoSender.setParameters(params);
            }
          }
        } catch (e) {
          console.log("Failed to adapt bandwidth", e);
        }

        return;
      }

      if (state === "disconnected" || state === "failed") {
        setConnectionQuality("Poor");
        setStatus("Reconnecting...");
        setIsReconnecting(true);

        if (iceRestartingRef.current || !targetId) return;
        iceRestartingRef.current = true;

        try {
          peer.restartIce();
          const offer = await peer.createOffer({ iceRestart: true });
          if (peer.signalingState === "closed") return;
          await peer.setLocalDescription(offer);
          socketRef.current?.emit("offer", {
            target: targetId,
            offer: peer.localDescription,
          });
          console.log("ICE restart offer sent");
        } catch (err) {
          console.error("ICE restart failed:", err);
        } finally {
          iceRestartingRef.current = false;
        }
      }
    };

    peersRef.current.set(targetId, peer);

    // ----------------------------------------------------
    // ADD LOCAL TRACKS
    // ----------------------------------------------------

    const stream = localStreamRef.current;

    if (stream) {
      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
      });
    }

    // ----------------------------------------------------
    // REMOTE TRACK
    // ----------------------------------------------------

    peer.ontrack = (event) => {
      console.log("Remote track received");

      const remoteStream = event.streams[0];

      if (remoteStream) {
        setRemoteStreams((prev) => ({ ...prev, [targetId]: remoteStream }));

        // ==========================================
        // REMOTE SPEAKING DETECTION
        // ==========================================

        const audioTrack =
          remoteStream.getAudioTracks()[0];

        if (audioTrack) {
          const audioContext =
            new AudioContext();

          const analyser =
            audioContext.createAnalyser();

          analyser.fftSize = 256;

          const source =
            audioContext.createMediaStreamSource(
              remoteStream
            );

          source.connect(analyser);

          const data =
            new Uint8Array(
              analyser.frequencyBinCount
            );

          const detectSpeaking = () => {
            analyser.getByteFrequencyData(data);

            const volume =
              data.reduce(
                (sum, value) => sum + value,
                0
              ) / data.length;

            setIsRemoteSpeaking(
              (prev) => ({ ...prev, [targetId]: volume > 20 })
            );

            requestAnimationFrame(
              detectSpeaking
            );
          };

          detectSpeaking();
        }

      }

      setStatus("Connected");
    };

    // ----------------------------------------------------
    // ICE
    // ----------------------------------------------------

    peer.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      const socket = socketRef.current;

      if (!socket) return;

      socket.emit("ice-candidate", {
        target: targetId,
        candidate: event.candidate,
      });
    };

    // ----------------------------------------------------
    // CONNECTION STATE
    // ----------------------------------------------------

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      console.log("WebRTC connection state:", state);

      if (state === "connected") {
        setConnectionQuality("Good");
        setStatus("Connected");
        setIsReconnecting(false);
        setIsRestoringCall(false);
        wasConnectedRef.current = true;
        reconnectAttemptsRef.current = 0;
      } else if (state === "connecting") {
        setConnectionQuality("Fair");
        setStatus("Connecting...");
        setIsReconnecting(true);
      } else if (state === "disconnected") {
        setConnectionQuality("Poor");
        setStatus("Reconnecting...");
        setIsReconnecting(true);
      } else if (state === "failed") {
        setConnectionQuality("Poor");
        setStatus("Connection failed. Retrying...");
        setIsReconnecting(true);
      } else if (state === "closed") {
        setConnectionQuality("Poor");
        setStatus("Connection closed");
      }
    };

    // ----------------------------------------------------
    // CREATE OFFER
    // ----------------------------------------------------

    if (createOffer) {
      peer
        .createOffer()
        .then((offer) => peer.setLocalDescription(offer))
        .then(() => {
          socketRef.current?.emit("offer", {
            target: targetId,
            offer: peer.localDescription,
          });
        })
        .catch((err) => {
          console.error("Offer error:", err);
        });
    }

    return peer;
  }, []);

  // ========================================================
  // START CALL
  // ========================================================

  useEffect(() => {
    if (!roomId) {
      return;
    }

    let cancelled = false;
    manuallyLeavingRef.current = false;
    reconnectAttemptsRef.current = 0;

    const startCall = async () => {
      try {
        console.log("Starting call for room:", roomId);

        setStatus("Requesting camera...");

        // ------------------------------------------------
        // CAMERA + MICROPHONE
        // ------------------------------------------------
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setError("Your browser is blocking camera access because the connection is not secure (HTTPS). Please use 'localhost' or a secure connection.");
          setStatus("Secure connection required");
          return;
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: facingMode
            },
            audio: {
              noiseSuppression: true,
              echoCancellation: true,
            },
          });
        } catch (err: any) {
          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
            setError("Camera and Microphone permissions are required. Please click the lock icon in your browser address bar and allow access.");
          } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
            setError("No camera or microphone found. Please connect a webcam/microphone to your computer and try again.");
          } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
            setError("Your camera or microphone is already in use by another application (like Zoom or Skype). Please close it and refresh.");
          } else {
            setError(`Could not access devices (${err.name || err.message}). Please check your hardware.`);
          }
          setStatus("Device error");
          return;
        }

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());

          return;
        }

        console.log("Camera stream obtained:", stream);

        localStreamRef.current = stream;

        // ------------------------------------------------
        // ATTACH LOCAL VIDEO
        // ------------------------------------------------

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;

          localVideoRef.current.muted = true;

          localVideoRef.current.play().catch((err) => {
            console.log("Local video play:", err);
          });
        }

        setStatus("Connecting...");

        // ------------------------------------------------
        // SOCKET
        // ------------------------------------------------

        const socket = io(SERVER_URL, {
          transports: ["websocket", "polling"],
        });

        socketRef.current = socket;

        socket.on("connect", () => {
          console.log("Socket connected:", socket.id);

          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }

          if (wasConnectedRef.current) {
            setConnectionQuality("Fair");
            setStatus("Reconnecting...");
            setIsReconnecting(true);
            setIsRestoringCall(true);
          } else {
            setStatus("Connected to server...");
          }

          socket.emit("join-call", { roomId, meetingToken: getMeetingToken(roomId), userName: user?.name });
        });

        // =================================================
        // ROOM JOINED
        // =================================================
        socket.on(
          "participant-media-status",
          ({ socketId, micEnabled, cameraEnabled }) => {
            if (socketId !== socketRef.current?.id) {
              setRemoteMicEnabled(micEnabled);
              setRemoteCameraEnabled(cameraEnabled);
            }
          },
        );

        socket.on(
          "room-joined",
          ({
            participants,
            hostId,
            isHost: joinedAsHost,
            isCoHost: joinedAsCoHost,
            meetingLocked,
            canChat,
            canScreenShare,
          }) => {
            console.log("Room joined:", participants);

            if (participants.length >= MAX_PARTICIPANTS) {
              setError(`This meeting is full. Maximum ${MAX_PARTICIPANTS} participants are allowed.`);
              setStatus("Meeting full");
              socket.emit("leave-call");
              socket.disconnect();
              return;
            }

            setParticipants(participants);

            setIsHost(Boolean(joinedAsHost));
            setIsCoHost(Boolean(joinedAsCoHost));
            setMeetingLocked(Boolean(meetingLocked));
            setChatAllowed(canChat !== false);
            setScreenShareAllowed(canScreenShare !== false);

            console.log("Host:", hostId, "You are host:", joinedAsHost);

            if (participants.length === 0) {
              setStatus("Waiting for participant...");
              setIsReconnecting(false);
              return;
            }

            participants.forEach((p: { socketId: string }) => {
              if (p.socketId !== socket.id) {
                createPeer(p.socketId, true);
              }
            });
          },
        );

        const durationInterval = window.setInterval(() => {
          setCallDuration((prev) => prev + 1);
        }, 1000);

        // =================================================
        // USER JOINED
        // =================================================

        socket.on("user-joined", ({ socketId, userName }) => {
          console.log("User joined:", socketId, userName);

          if (participants.length + 1 > MAX_PARTICIPANTS) {
            setError(`Maximum ${MAX_PARTICIPANTS} participants allowed.`);
            setStatus("Participant limit reached");
            return;
          }

          setParticipants((current) => {
            if (current.some(p => p.socketId === socketId)) {
              return current;
            }

            return [...current, { socketId, userName: userName || "Guest" }];
          });

          setStatus("Participant joined...");
        });

        // =================================================
        // RAISE HAND - RECEIVE FROM OTHER PARTICIPANT
        // =================================================

        socket.on("participant-hand", ({ socketId, raised }) => {
          console.log("Participant hand:", socketId, raised);

          // If this event belongs to the other participant,
          // update the remote video indicator.
          if (socketRef.current && socketId !== socketRef.current.id) {
            setRemoteHandRaised((prev) => ({ ...prev, [socketId]: Boolean(raised) }));
          }

          // Keep participant list status
          setRaisedHands((current) => {
            if (raised) {
              if (current.includes(socketId)) {
                return current;
              }

              return [...current, socketId];
            }

            return current.filter((id) => id !== socketId);
          });
        });
        // =================================================
        // OFFER
        // =================================================

        socket.on("offer", async ({ sender, offer }) => {
          remoteSocketIdRef.current = null;

          setStatus("Waiting for participant...");
        });

        // =================================================
        // CALL ERROR
        // =================================================

        socket.on("call-error", ({ message }) => {
          console.error("Call error:", message);

          setError(message);

          setStatus("Call error");
        });

        // =================================================
        // HOST MODERATION EVENTS
        // =================================================

        socket.on("force-mute", () => {
          const stream = localStreamRef.current;

          if (!stream) return;

          stream.getAudioTracks().forEach((track) => {
            track.enabled = false;
          });

          setMicEnabled(false);
          setError("You were muted by the host.");
        });

        socket.on("removed-from-call", () => {
          setError("You were removed from the meeting.");
          setStatus("Removed from meeting");

          for (const [id, peer] of Array.from(peersRef.current.entries())) {
            peer.close();
            peersRef.current.delete(id);
          }

          localStreamRef.current?.getTracks().forEach((track) => track.stop());
          localStreamRef.current = null;

          socket.disconnect();

          setTimeout(() => {
            router.push("/");
          }, 1500);
        });

        socket.on("meeting-lock-changed", ({ locked }) => {
          setMeetingLocked(Boolean(locked));
        });

        socket.on("cohost-changed", ({ socketId, isCoHost }) => {
          if (socketId === socket.id) {
            setIsCoHost(Boolean(isCoHost));
          }
        });

        socket.on("host-changed", ({ hostId }) => {
          setIsHost(hostId === socket.id);

          if (hostId === socket.id) {
            setIsCoHost(false);
          }
        });

        socket.on("chat-permission-changed", ({ allowed }) => {
          setChatAllowed(Boolean(allowed));

          if (!allowed) {
            setChatMessage("");
          }
        });

        socket.on("screen-share-permission-changed", ({ allowed }) => {
          setScreenShareAllowed(Boolean(allowed));

          if (!allowed && isScreenSharing) {
            stopScreenSharing();
          }
        });

        socket.on("disconnect", (reason) => {
          console.log("Socket disconnected:", reason);
          if (manuallyLeavingRef.current) return;

          setConnectionQuality("Poor");
          setStatus("Reconnecting...");
          setIsReconnecting(true);
          setIsRestoringCall(wasConnectedRef.current);

          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

          const attemptReconnect = () => {
            if (manuallyLeavingRef.current || socket.connected) return;

            if (reconnectAttemptsRef.current >= 5) {
              setStatus("Unable to reconnect");
              setError("Connection lost. Please refresh the call to try again.");
              return;
            }

            reconnectAttemptsRef.current += 1;
            setStatus(`Reconnecting... (${reconnectAttemptsRef.current}/5)`);
            socket.connect();

            reconnectTimerRef.current = setTimeout(attemptReconnect, 2500);
          };

          reconnectTimerRef.current = setTimeout(attemptReconnect, 1000);
        });
      } catch (err) {
        console.error("Camera error:", err);

        setError(
          "Unable to access camera or microphone. Check browser permissions.",
        );

        setStatus("Camera unavailable");
      }
    };

    startCall();

    // ======================================================
    // CLEANUP
    // ======================================================

    return () => {
      cancelled = true;
      manuallyLeavingRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (restoreTimeoutRef.current) {
        clearTimeout(restoreTimeoutRef.current);
        restoreTimeoutRef.current = null;
      }
      setIsReconnecting(false);
      setIsRestoringCall(false);

      socketRef.current?.emit("leave-call");

      socketRef.current?.disconnect();

      for (const [id, peer] of Array.from(peersRef.current.entries())) {
        peer.close();
        peersRef.current.delete(id);
      }

      screenStreamRef.current?.getTracks().forEach((track) => track.stop());

      screenStreamRef.current = null;

      localStreamRef.current?.getTracks().forEach((track) => track.stop());

      socketRef.current = null;

      localStreamRef.current = null;
    };
  }, [roomId, createPeer]);

  // ========================================================
  // MICROPHONE
  // ========================================================

  const toggleFullscreen = async (target: "local" | "remote" | string) => {
    // Note: Remote fullscreen toggling in Mesh is simplified or requires finding the correct DOM node.
    // For now, we only support local fullscreen via this generic toggle, or remote via specific buttons.
    const element = target === "local" ? localVideoRef.current : document.getElementById(`video-${target}`);
    if (!element) return;
    try {
      if (document.fullscreenElement === element) { await document.exitFullscreen(); return; }
      if (document.fullscreenElement) await document.exitFullscreen();
      await element.requestFullscreen();
    } catch (e) { console.error("Fullscreen error:", e); setError("Fullscreen is not available in this browser."); }
  };

  const togglePin = (target: "local" | "remote" | string) => {
    setPinnedParticipant((current) => current === target ? "remote" : target);
  };

  const clearChatForMe = () => { setChatMessages([]); setUnreadChatCount(0); setLastReadChatCount(0); };
  const markChatAsRead = () => { setUnreadChatCount(0); setLastReadChatCount(chatMessages.length); };

  const toggleWaitingRoom = () => {
    if (!isHost) return;
    const enabled = !waitingRoomEnabled;
    setWaitingRoomEnabled(enabled);
    socketRef.current?.emit("host-waiting-room", { roomId, enabled });
  };

  const requestMuteAll = () => {
    if (!isHost && !isCoHost) return;
    setMuteAllRequested(true);
    participants.forEach((participant) => muteParticipant(participant.socketId));
    window.setTimeout(() => setMuteAllRequested(false), 2500);
  };

  const lowerAllHands = () => {
    if (!isHost && !isCoHost) return;
    setRaisedHands([]); setRemoteHandRaised({}); setHandRaised(false);
    socketRef.current?.emit("host-lower-all-hands", { roomId });
  };

  useEffect(() => {
    const onFullscreen = () => {
      setIsLocalFullscreen(document.fullscreenElement === localVideoRef.current);
      setIsRemoteFullscreen(false); // Simplified for mesh
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => { if (showChat) markChatAsRead(); }, [showChat, chatMessages.length]);
  useEffect(() => {
    if (!showChat && chatMessages.length > lastReadChatCount) setUnreadChatCount(chatMessages.length - lastReadChatCount);
  }, [chatMessages.length, lastReadChatCount, showChat]);

  const toggleMicrophone = () => {
    const stream = localStreamRef.current;

    if (!stream) {
      console.log("No local stream");

      return;
    }

    const tracks = stream.getAudioTracks();

    if (!tracks.length) {
      return;
    }

    const newState = !tracks[0].enabled;

    tracks.forEach((track) => {
      track.enabled = newState;
    });

    setMicEnabled(newState);

    console.log("Microphone:", newState);
  };

  // ========================================================
  // CAMERA
  // ========================================================

  const toggleCamera = () => {
    const stream = localStreamRef.current;

    if (!stream) {
      console.log("No local stream");

      return;
    }

    const tracks = stream.getVideoTracks();

    if (!tracks.length) {
      return;
    }

    const newState = !tracks[0].enabled;

    tracks.forEach((track) => {
      track.enabled = newState;
    });

    setCameraEnabled(newState);

    console.log("Camera:", newState);
  };

  // ========================================================
  // TASK 6 - FRONT / REAR CAMERA SWITCHING
  // ========================================================

  const switchCamera = async () => {
    if (isSwitchingCamera || isScreenSharing) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera switching is not supported by this browser.");
      return;
    }

    const currentStream = localStreamRef.current;
    const currentTrack = currentStream?.getVideoTracks()[0];

    if (!currentTrack) {
      setError("No active camera is available.");
      return;
    }

    const currentFacing =
      (currentTrack.getSettings().facingMode as "user" | "environment" | undefined) || "user";
    const nextFacing = currentFacing === "environment" ? "user" : "environment";

    setIsSwitchingCamera(true);
    setError("");

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing } },
        audio: false,
      });

      const nextTrack = nextStream.getVideoTracks()[0];
      if (!nextTrack) throw new Error("No camera track returned.");

      // For mesh we update all connections
      for (const peer of Array.from(peersRef.current.values())) {
        const sender = peer.getSenders().find((item) => item.track?.kind === "video");

        if (sender) {
          await sender.replaceTrack(nextTrack);
        }
      }

      if (currentStream) {
        currentStream.removeTrack(currentTrack);
        currentTrack.stop();
        currentStream.addTrack(nextTrack);
        localStreamRef.current = currentStream;
      } else {
        localStreamRef.current = nextStream;
      }

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
        localVideoRef.current.muted = true;
        await localVideoRef.current.play().catch(() => { });
      }

      setCameraEnabled(true);
      sendMediaStatus();
    } catch (err) {
      console.error("Camera switch error:", err);
      setError("Unable to switch camera. Your device may have only one available camera.");
    } finally {
      setIsSwitchingCamera(false);
    }
  };

  // ========================================================
  // SCREEN SHARING
  // ========================================================

  const stopScreenSharing = async () => {
    const screenStream = screenStreamRef.current;

    if (!screenStream) {
      return;
    }

    const cameraStream = localStreamRef.current;

    const cameraTrack = cameraStream?.getVideoTracks()[0] || null;

    if (cameraTrack) {
      for (const peer of Array.from(peersRef.current.values())) {
        const videoSender = peer
          .getSenders()
          .find((sender) => sender.track?.kind === "video");

        if (videoSender) {
          try {
            await videoSender.replaceTrack(cameraTrack);
          } catch (err) {
            console.error("Failed to restore camera track:", err);
          }
        }
      }
    }

    screenStream.getTracks().forEach((track) => track.stop());

    screenStreamRef.current = null;
    setIsScreenSharing(false);
    setCameraEnabled(true);

    if (localVideoRef.current && cameraStream) {
      localVideoRef.current.srcObject = cameraStream;
      localVideoRef.current.muted = true;

      localVideoRef.current.play().catch(() => { });
    }
  };

  const startScreenSharing = async () => {
    if (!screenShareAllowed && !isHost && !isCoHost) {
      setError("Screen sharing has been disabled by the host.");
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen sharing is not supported by this browser.");
      return;
    }

    try {
      setError("");

      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const screenTrack = screenStream.getVideoTracks()[0];

      if (!screenTrack) {
        screenStream.getTracks().forEach((track) => track.stop());
        return;
      }

      screenStreamRef.current = screenStream;

      // Show the shared screen locally.
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
        localVideoRef.current.muted = true;

        localVideoRef.current.play().catch(() => { });
      }

      // Replace the camera video track on the
      // existing WebRTC connection.
      
      for (const peer of Array.from(peersRef.current.values())) {
        const videoSender = peer
          .getSenders()
          .find((sender) => sender.track?.kind === "video");

        if (videoSender) {
          await videoSender.replaceTrack(screenTrack);
        } else {
          peer.addTrack(screenTrack, screenStream);
        }
      }

      setIsScreenSharing(true);
      setCameraEnabled(false);

      screenTrack.onended = () => {
        stopScreenSharing();
      };

      console.log("Screen sharing started");
    } catch (err: any) {
      console.error("Screen sharing error:", err);

      // User cancelling the browser's screen picker
      // is not treated as an application error.
      if (err?.name !== "AbortError") {
        setError("Unable to start screen sharing.");
      }
    }
  };

  const toggleScreenSharing = async () => {
    if (isScreenSharing) {
      await stopScreenSharing();
    } else {
      await startScreenSharing();
    }
  };

  // ========================================================
  // HOST MODERATION
  // ========================================================

  const muteParticipant = (targetId: string) => {
    if (!isHost && !isCoHost) return;

    socketRef.current?.emit("host-mute-participant", {
      targetId,
    });
  };

  const removeParticipant = (targetId: string) => {
    if (!isHost && !isCoHost) return;

    socketRef.current?.emit("host-remove-participant", {
      targetId,
    });
  };

  const toggleMeetingLock = () => {
    if (!isHost) return;

    socketRef.current?.emit("host-lock-meeting", {
      locked: !meetingLocked,
    });
  };

  const setParticipantCoHost = (targetId: string, value: boolean) => {
    if (!isHost) return;

    socketRef.current?.emit("host-set-cohost", {
      targetId,
      isCoHost: value,
    });
  };

  const toggleChatPermission = () => {
    if (!isHost && !isCoHost) return;

    socketRef.current?.emit("host-chat-permission", {
      allowed: !chatAllowed,
    });
  };

  const toggleScreenSharePermission = () => {
    if (!isHost && !isCoHost) return;

    socketRef.current?.emit("host-screen-share-permission", {
      allowed: !screenShareAllowed,
    });
  };

  // ========================================================
  // SEND CHAT MESSAGE
  // ========================================================

  const sendChatMessage = () => {
    const message = chatMessage.trim();

    if (!message && !chatFile) {
      return;
    }

    if (!socketRef.current) {
      return;
    }

    if (!chatAllowed && !isHost && !isCoHost) {
      setError("Chat has been disabled by the host.");
      return;
    }

    socketRef.current.emit("call-chat-message", {
      roomId,
      message,
    });

    setChatMessage("");
  };

  // ========================================================
  // TOGGLE RAISE HAND
  // ========================================================

  const toggleRaiseHand = () => {
    const nextState = !handRaised;

    setHandRaised(nextState);

    socketRef.current?.emit("raise-hand", {
      roomId,
      raised: nextState,
    });
  };

  const sendMediaStatus = () => {
    if (!socketRef.current) return;

    socketRef.current.emit(
      "participant-media-status",
      {
        roomId,
        micEnabled:
          localStreamRef.current?.getAudioTracks()[0]
            ?.enabled ?? false,
        cameraEnabled:
          localStreamRef.current?.getVideoTracks()[0]
            ?.enabled ?? false,
      }
    );
  };

  sendMediaStatus();

  // ========================================================
  // BATCH 3 - REFRESH / VISIBILITY RECOVERY
  // ========================================================

  useEffect(() => {
    const handleOnline = () => {
      if (manuallyLeavingRef.current || !roomId) return;

      setIsReconnecting(true);
      setIsRestoringCall(true);
      setConnectionQuality("Fair");
      setStatus("Restoring call...");

      if (socketRef.current && !socketRef.current.connected) {
        socketRef.current.connect();
      } else if (socketRef.current?.connected) {
        socketRef.current.emit("join-call", { roomId, userName: user?.name });
      }
    };

    const handleOffline = () => {
      if (manuallyLeavingRef.current) return;
      setConnectionQuality("Poor");
      setIsReconnecting(true);
      setStatus("You are offline. Waiting for network...");
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (manuallyLeavingRef.current || !roomId) return;

      const socket = socketRef.current;

      if (!socket || !socket.connected) {
        setIsRestoringCall(true);
        setIsReconnecting(true);
        setStatus("Restoring call...");
        setConnectionQuality("Fair");

        if (socket && !socket.connected) {
          socket.connect();
        }
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [roomId, user]);

  // ========================================================
  // LEAVE
  // ========================================================

  const leaveCall = () => {
    manuallyLeavingRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (restoreTimeoutRef.current) {
      clearTimeout(restoreTimeoutRef.current);
      restoreTimeoutRef.current = null;
    }
    setIsReconnecting(false);
    setIsRestoringCall(false);

    socketRef.current?.emit("leave-call");

    socketRef.current?.disconnect();

    for (const [id, peer] of Array.from(peersRef.current.entries())) {
      peer.close();
      peersRef.current.delete(id);
    }

    screenStreamRef.current?.getTracks().forEach((track) => track.stop());

    screenStreamRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());

    socketRef.current = null;

    localStreamRef.current = null;

    router.push("/");
  };

  // ========================================================
  // UI
  // ========================================================

  return (
    <div className="min-h-screen bg-black text-white">
      {/* HEADER */}

      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">Video Call</h1>

          <p className="text-sm text-gray-400">
            Room: {roomId || "Loading..."}
          </p>

          <div className="text-sm text-gray-400">
            Call duration: {formatCallDuration(callDuration)}
          </div>

          {(isHost || isCoHost) && (
            <div className="mt-1 text-xs font-semibold text-yellow-400">
              {isHost ? "👑 Host" : "🛡️ Co-host"}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className={`rounded-full px-3 py-1 text-xs font-semibold ${connectionQuality === "Good"
              ? "bg-green-500/20 text-green-400"
              : connectionQuality === "Fair"
                ? "bg-yellow-500/20 text-yellow-400"
                : "bg-red-500/20 text-red-400"
            }`}>
            {connectionQuality === "Good" ? "🟢" : connectionQuality === "Fair" ? "🟡" : "🔴"} {connectionQuality}
          </div>

          <div className="text-sm">{status}</div>
        </div>
      </div>

      {/* ERROR */}

      {error && (
        <div className="mx-6 mt-4 rounded-lg bg-red-900/50 p-3 text-red-300">
          {error}
        </div>
      )}

      {isReconnecting && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
          <div className="rounded-2xl border border-gray-700 bg-gray-900/95 px-8 py-6 text-center shadow-2xl">
            <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-4 border-gray-600 border-t-white" />
            <p className="text-lg font-semibold">
              {isRestoringCall ? "Restoring call..." : "Reconnecting..."}
            </p>
            <p className="mt-1 text-sm text-gray-400">
              Please wait while we restore your connection.
            </p>
          </div>
        </div>
      )}

      {/* VIDEO GRID */}

      <div className={`grid min-h-[70vh] gap-4 p-6 ${viewMode === "grid" ? "md:grid-cols-2" : "md:grid-cols-1"}`}>
        {/* LOCAL VIDEO */}

        <div className="relative overflow-hidden rounded-xl bg-gray-900">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`h-full min-h-[300px] w-full object-cover ${!cameraEnabled ? "opacity-0" : ""}`}
          />

          {!cameraEnabled && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900">
              <div className="mb-3 flex h-24 w-24 items-center justify-center rounded-full bg-gray-700 text-5xl">👤</div>
              <p className="text-sm text-gray-400">Camera is off</p>
            </div>
          )}

          {handRaised && (
            <div className="absolute right-4 top-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-yellow-500 text-3xl shadow-lg">
              ✋
            </div>
          )}

          <div className="absolute bottom-4 left-4 rounded-lg bg-black/70 px-3 py-1">You {isHost ? "👑" : isCoHost ? "🛡️" : ""}</div>
          <div className="absolute right-4 top-4 z-30 flex gap-2">
            <button type="button" onClick={() => togglePin("local")} className="rounded-full bg-black/70 px-3 py-2 text-xs">📌 {pinnedParticipant === "local" ? "Pinned" : "Pin"}</button>
            <button type="button" onClick={() => toggleFullscreen("local")} className="rounded-full bg-black/70 px-3 py-2 text-xs">{isLocalFullscreen ? "⛶ Exit" : "⛶ Fullscreen"}</button>
          </div>
          <div className="absolute bottom-4 right-4 rounded-full bg-black/80 px-3 py-2 text-sm">{micEnabled ? "🎤" : "🔇"} {cameraEnabled ? "📷" : "🚫📷"}</div>
        </div>


        
        {/* REMOTE VIDEOS */}
        {Object.entries(remoteStreams).map(([socketId, stream]) => {
          const micOn = remoteMicEnabled[socketId] !== false;
          const camOn = remoteCameraEnabled[socketId] !== false;
          const isSpeaking = isRemoteSpeaking[socketId];
          const hasHandRaised = remoteHandRaised[socketId];
          const isPinned = pinnedParticipant === socketId;
          const isFullscreen = isRemoteFullscreen; // simplify for now
          
          return (
            <div key={socketId} className="relative overflow-hidden rounded-xl bg-gray-900">
              {isSpeaking && (
                <div className="absolute inset-0 pointer-events-none rounded-xl border-4 border-green-400 z-10" />
              )}
              <video
                autoPlay
                playsInline
                ref={(el) => { if (el) el.srcObject = stream; }}
                className={`h-full min-h-[300px] w-full object-cover ${!camOn ? "opacity-0" : ""}`}
              />

              {!camOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900">
                  <div className="mb-3 flex h-24 w-24 items-center justify-center rounded-full bg-gray-700 text-5xl">👤</div>
                  <p className="text-sm text-gray-400">Participant camera is off</p>
                </div>
              )}

              {hasHandRaised && (
                <div className="absolute right-4 top-4 z-20 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500 text-4xl shadow-xl">✋</div>
              )}
              <div className="absolute left-4 top-4 z-30 flex gap-2">
                <button type="button" onClick={() => togglePin(socketId)} className="rounded-full bg-black/70 px-3 py-2 text-xs">📌 {isPinned ? "Pinned" : "Pin"}</button>
                <button type="button" onClick={() => toggleFullscreen(socketId)} className="rounded-full bg-black/70 px-3 py-2 text-xs">{isFullscreen ? "⛶ Exit" : "⛶ Fullscreen"}</button>
              </div>

              {!stream && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                  Waiting for participant...
                </div>
              )}

              <div className="absolute bottom-4 left-4 rounded-lg bg-black/70 px-3 py-1 text-sm font-semibold text-white">
                Participant
              </div>

              <div className="absolute bottom-4 right-4 flex gap-2">
                <div className="rounded-full bg-black/80 px-3 py-2 text-sm text-white">
                  {micOn ? "🎤" : "🔇"}
                </div>
                <div className="rounded-full bg-black/80 px-3 py-2 text-sm text-white">
                  {camOn ? "📷" : "🚫📷"}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div><p className="text-sm font-semibold">Call view</p><p className="text-xs text-gray-500">Choose grid or speaker layout.</p></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setViewMode("grid")} className={`rounded-lg px-4 py-2 text-sm ${viewMode === "grid" ? "bg-blue-600" : "bg-gray-800"}`}>🔲 Grid</button>
          <button type="button" onClick={() => setViewMode("speaker")} className={`rounded-lg px-4 py-2 text-sm ${viewMode === "speaker" ? "bg-blue-600" : "bg-gray-800"}`}>🗣️ Speaker</button>
        </div>
      </div>

      {showParticipants && (
        <div className="mx-6 mb-4 rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Participants</h2>

            <button
              type="button"
              onClick={() => setShowParticipants(false)}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-gray-800 p-3">
              <div>
                <p className="font-medium">
                  You {isHost ? "👑 Host" : isCoHost ? "🛡️ Co-host" : ""}
                </p>

                <p className="text-xs text-gray-400">
                  {micEnabled ? "🎤 Microphone on" : "🔇 Microphone off"}
                </p>
              </div>

              <span>{cameraEnabled ? "📷" : "🚫📷"}</span>
            </div>

            {participants.map((participant) => (
              <div
                key={participant.socketId}
                className="rounded-lg bg-gray-800 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{participant.userName}</p>

                    <p className="max-w-[250px] truncate text-xs text-gray-400">
                      {participant.socketId}
                    </p>

                    {raisedHands.includes(participant.socketId) && (
                      <p className="mt-1 text-xs text-yellow-400">
                        ✋ Hand raised
                      </p>
                    )}
                  </div>

                  <span>👤</span>
                </div>

                {(isHost || isCoHost) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => muteParticipant(participant.socketId)}
                      className="rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-medium hover:bg-yellow-700"
                    >
                      🔇 Mute
                    </button>

                    <button
                      type="button"
                      onClick={() => removeParticipant(participant.socketId)}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium hover:bg-red-700"
                    >
                      ❌ Remove
                    </button>

                    {isHost && (
                      <button
                        type="button"
                        onClick={() => setParticipantCoHost(participant.socketId, true)}
                        className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium hover:bg-purple-700"
                      >
                        👑 Make Co-host
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {participants.length === 0 && (
              <p className="text-sm text-gray-500">No other participants</p>
            )}
          </div>

          {(isHost || isCoHost) && (
            <div className="mt-5 border-t border-gray-700 pt-4">
              <p className="mb-3 text-sm font-semibold text-gray-300">
                {isHost ? "👑 Host Controls" : "🛡️ Co-host Controls"}
              </p>

              <div className="flex flex-wrap gap-2">
                {isHost && (
                  <button
                    type="button"
                    onClick={toggleMeetingLock}
                    className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${meetingLocked
                        ? "bg-green-600 hover:bg-green-700"
                        : "bg-gray-700 hover:bg-gray-600"
                      }`}
                  >
                    {meetingLocked ? "🔓 Unlock Meeting" : "🔒 Lock Meeting"}
                  </button>
                )}

                <button
                  type="button"
                  onClick={toggleChatPermission}
                  className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-600"
                >
                  {chatAllowed ? "💬 Disable Chat" : "💬 Enable Chat"}
                </button>

                <button
                  type="button"
                  onClick={toggleScreenSharePermission}
                  className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-600"
                >
                  {screenShareAllowed
                    ? "🖥️ Disable Screen Share"
                    : "🖥️ Enable Screen Share"}
                </button>

                {isHost && (
                  <>
                    <button type="button" onClick={toggleWaitingRoom} className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white">{waitingRoomEnabled ? "🚪 Waiting Room On" : "🚪 Waiting Room Off"}</button>
                    <button type="button" onClick={requestMuteAll} className="rounded-lg bg-yellow-700 px-4 py-2 text-sm font-medium text-white">{muteAllRequested ? "🔇 Requested" : "🔇 Mute All"}</button>
                  </>
                )}
                {(isHost || isCoHost) && <button type="button" onClick={lowerAllHands} className="rounded-lg bg-yellow-600 px-4 py-2 text-sm font-medium text-white">✋ Lower All Hands</button>}
              </div>
            </div>
          )}
        </div>
      )}


      {showChat && (
        <div className="mx-6 mb-4 flex h-[400px] flex-col rounded-xl border border-gray-800 bg-gray-900">
          {/* HEADER */}

          <div className="flex items-center justify-between border-b border-gray-800 p-4">
            <div className="flex items-center gap-2"><h2 className="font-semibold">In-call Chat</h2>{unreadChatCount > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold">{unreadChatCount} new</span>}</div>
            <div className="flex items-center gap-2"><button type="button" onClick={clearChatForMe} className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs">Clear</button><button type="button" onClick={() => setShowChat(false)} className="text-gray-400 hover:text-white">✕</button></div>
          </div>

          {/* MESSAGES */}

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {chatMessages.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">
                No messages yet
              </div>
            )}

            {chatMessages.map((chat, index) => {
              const isMe = chat.sender === socketRef.current?.id;

              return (
                <div
                  key={`${chat.timestamp}-${index}`}
                  className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[75%] rounded-xl px-4 py-2 ${isMe ? "bg-blue-600" : "bg-gray-800"
                      }`}
                  >
                    <p className="break-words text-sm">{chat.message}</p>

                    {chat.file && (
                      <div className="mt-2 rounded-lg border border-gray-700 bg-gray-900 p-2">
                        {chat.file.type.startsWith("image/") ? (
                          <img src={chat.file.data} alt="attachment" className="max-h-32 rounded object-contain" />
                        ) : (
                          <a href={chat.file.data} download={chat.file.name} className="flex items-center gap-2 text-xs text-blue-400 hover:underline">
                            <span>📎</span> {chat.file.name}
                          </a>
                        )}
                      </div>
                    )}

                    <div className="mt-1 flex items-center justify-between gap-3"><p className="text-[10px] opacity-60">{new Date(chat.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>{isMe && <button type="button" onClick={() => setChatMessages((current) => current.filter((_, i) => i !== index))} className="text-[10px] text-gray-300">Delete</button>}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* INPUT */}

          <div className="flex flex-col gap-2 border-t border-gray-800 p-3">
            {chatFile && (
              <div className="flex items-center justify-between rounded bg-gray-800 p-2 text-xs">
                <span className="truncate">{chatFile.name}</span>
                <button type="button" onClick={() => setChatFile(null)} className="text-red-400 hover:text-red-300">✕</button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <label className={`flex h-12 w-12 cursor-pointer items-center justify-center rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 ${(!chatAllowed && !isHost && !isCoHost) ? "pointer-events-none opacity-50" : ""}`}>
                📎
                <input type="file" className="hidden" onChange={handleFileChange} disabled={!chatAllowed && !isHost && !isCoHost} />
              </label>

              <input
                type="text"
                value={chatMessage}
                onChange={(e) => setChatMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    sendChatMessage();
                  }
                }}
                placeholder={chatAllowed || isHost || isCoHost ? "Type a message..." : "Chat disabled by host"}
                disabled={!chatAllowed && !isHost && !isCoHost}
                className="flex-1 rounded-lg bg-gray-800 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              />

              <button
                type="button"
                onClick={sendChatMessage}
                disabled={!chatAllowed && !isHost && !isCoHost}
                className="rounded-lg bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
      
      {showMeetingSettings && (
        <div className="mx-6 mb-4 rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Meeting Settings</h2>
              <p className="text-xs text-gray-500">Current call status.</p>
            </div>
            <button type="button" onClick={() => setShowMeetingSettings(false)} className="text-gray-400">✕</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-gray-800 p-3">
              <p className="text-xs text-gray-400">Participants</p>
              <p className="mt-1 font-medium">{participants.length + 1} / {MAX_PARTICIPANTS}</p>
            </div>
            <div className="rounded-lg bg-gray-800 p-3">
              <p className="text-xs text-gray-400">Meeting security</p>
              <p className="mt-1 font-medium">{meetingToken ? "Session authenticated" : "Initializing..."}</p>
            </div>
            <div className="rounded-lg bg-gray-800 p-3">
              <p className="text-xs text-gray-400">Connection</p>
              <p className="mt-1 font-medium">{connectionQuality}</p>
            </div>
            <div className="rounded-lg bg-gray-800 p-3">
              <p className="text-xs text-gray-400">Status</p>
              <p className="mt-1 font-medium">{status}</p>
            </div>
          </div>
        </div>
      )}

      {/* CONTROLS */}
      <div className="flex justify-center gap-3 border-t border-gray-800 p-6">
        <button
          type="button"
          onClick={toggleMicrophone}
          className="cursor-pointer rounded-full bg-gray-800 px-6 py-3 text-white hover:bg-gray-700"
        >
          {micEnabled ? "🎤 Mute" : "🔇 Unmute"}
        </button>

        <button
          type="button"
          onClick={toggleCamera}
          className="cursor-pointer rounded-full bg-gray-800 px-6 py-3 text-white hover:bg-gray-700"
        >
          {cameraEnabled ? "📷 Camera Off" : "📷 Camera On"}
        </button>

        <button
          type="button"
          onClick={switchCamera}
          disabled={isSwitchingCamera || isScreenSharing}
          className="cursor-pointer rounded-full bg-gray-800 px-6 py-3 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSwitchingCamera ? "🔄 Switching..." : "🔄 Switch Camera"}
        </button>

        {isHost && (
          <button
            type="button"
            onClick={toggleRecording}
            className={`cursor-pointer rounded-full px-6 py-3 text-white ${isRecording ? "bg-red-600 hover:bg-red-700" : "bg-gray-800 hover:bg-gray-700"
              }`}
          >
            {isRecording ? "⏹️ Stop Recording" : "⏺️ Record"}
          </button>
        )}

        <button
          type="button"
          onClick={toggleScreenSharing}
          disabled={!screenShareAllowed && !isHost && !isCoHost}
          className={`cursor-pointer rounded-full px-6 py-3 text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${isScreenSharing ? "bg-orange-600" : "bg-gray-800"
            }`}
        >
          {isScreenSharing ? "🛑 Stop Sharing" : "🖥️ Share Screen"}
        </button>

        <button type="button" onClick={() => setShowMeetingSettings((current) => !current)} className="cursor-pointer rounded-full bg-gray-800 px-6 py-3 text-white hover:bg-gray-700">⚙️ Settings</button>

        <button
          type="button"
          onClick={leaveCall}
          className="cursor-pointer rounded-full bg-red-600 px-7 py-3 font-semibold text-white hover:bg-red-700"
        >
          📞 Leave
        </button>

        <button
          type="button"
          onClick={() => setShowParticipants((current) => !current)}
          className="cursor-pointer rounded-full bg-gray-800 px-6 py-3 text-white hover:bg-gray-700"
        >
          👥 Participants ({participants.length + 1})
        </button>

        <button
          type="button"
          onClick={() => setShowChat((current) => !current)}
          className="cursor-pointer rounded-full bg-gray-800 px-6 py-3 text-white hover:bg-gray-700"
        >
          💬 Chat ({chatMessages.length}){unreadChatCount > 0 ? ` • ${unreadChatCount} new` : ""}
        </button>

        <button
          type="button"
          onClick={toggleRaiseHand}
          className={`cursor-pointer rounded-full px-6 py-3 text-white ${handRaised
              ? "bg-yellow-600 hover:bg-yellow-700"
              : "bg-gray-800 hover:bg-gray-700"
            }`}
        >
          {handRaised ? "✋ Lower Hand" : "✋ Raise Hand"}
        </button>
      </div>
    </div>
  );
}
