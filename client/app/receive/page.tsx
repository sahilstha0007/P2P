"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { WifiAnimation } from "@/components/wifi-animation";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DownloadIcon,
  ArrowLeft,
  WifiIcon,
  Loader2Icon,
  CheckIcon,
  AlertCircleIcon,
} from "lucide-react";
import Link from "next/link";

export default function ReceivePage() {
  const searchParams = useSearchParams();
  const senderId = searchParams.get("id");

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [fileMetadata, setFileMetadata] = useState<{
    name: string;
    size: number;
  } | null>(null);
  const [transferProgress, setTransferProgress] = useState(0);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // const [receivedBytes, setReceivedBytes] = useState(0)

  const receivedBytes = useRef<number>(0);
  const fileSizeRef = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const receivedChunksRef = useRef<ArrayBuffer[]>([]);
  const reconnectAttemptsRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY = 3000;
  // Flag to track if we've already initiated file completion
  const completingTransferRef = useRef(false);

  const handleFileInfo = (data: { name: string; size: number }) => {
    const fileInfo = {
      name: data.name,
      size: data.size,
    };
    setFileMetadata(fileInfo);
    fileSizeRef.current = data.size; // Update the ref
    receivedChunksRef.current = [];
    receivedBytes.current = 0;
    setTransferProgress(0);
    setError(null);
    completingTransferRef.current = false;
  };

  const handleReceivedChunk = (chunkData: ArrayBuffer) => {
    if (!chunkData || chunkData.byteLength === 0) {
      return;
    }
    receivedChunksRef.current.push(chunkData);
    const newReceivedBytes = receivedBytes.current + chunkData.byteLength;
    receivedBytes.current = newReceivedBytes;

    // Calculate progress using the ref instead of state
    if (fileSizeRef.current > 0) {
      const progress = Math.min(
        100,
        Math.floor((newReceivedBytes / fileSizeRef.current) * 100)
      );
      setTransferProgress(progress);
      
      // Only attempt completion if not already in progress and we've reached threshold
      if (!fileUrl && !completingTransferRef.current && newReceivedBytes >= fileSizeRef.current * 0.99) {
        console.log("Received 99% of file, initiating completion process");
        completingTransferRef.current = true;
        setTimeout(() => completeFileTransfer(), 300);
      }
    }
  };

  const connectWebSocket = () => {
    if (!senderId) {
      return;
    }

    console.log("Connect to server button clicked");
    setIsConnecting(true);
    setError(null);

    receivedChunksRef.current = [];
    receivedBytes.current = 0;
    setTransferProgress(0);
    completingTransferRef.current = false;

    // Direct connection to the known working server
    const wsUrl = 'ws://localhost:3000/ws';
    console.log("Connecting directly to:", wsUrl);
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log(`✅ Connection successful with: ${wsUrl}`);
        
        // Generate a unique connection ID
        const connectionId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : "fallback-" + Math.random().toString(36).substring(2, 15);
        
        console.log("Registering with connection ID:", connectionId);
        ws.send(
          JSON.stringify({
            type: "register",
            connectionId: connectionId,
          })
        );
        
        // Important: Send receiver-ready message that matches sender expectations
        // This message is critical for the handshake to work properly
        console.log("Sending receiver-ready with target:", senderId);
        
        // Send in exact format expected by sender, with all required fields
        const readyMsg = {
          type: "receiver-ready",
          senderId: senderId,
          target_id: senderId,
          receiverId: connectionId
        };
        console.log("Ready message payload:", JSON.stringify(readyMsg));
        ws.send(JSON.stringify(readyMsg));
        
        // Send another ready signal after a short delay in case the first one was missed
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            console.log("Sending follow-up ready signal");
            ws.send(JSON.stringify(readyMsg));
          }
        }, 1000);
        
        // Setup ping interval to keep connection alive
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            console.log("Sending ping to keep connection alive");
            ws.send(JSON.stringify({ type: "ping" }));
          } else {
            clearInterval(pingInterval);
          }
        }, 15000);
        
        setIsConnected(true);
        setIsConnecting(false);
        setupWebSocketHandlers(ws);
      };
      
      ws.onerror = (event) => {
        console.error("WebSocket connection error:", event);
        setIsConnected(false);
        setIsConnecting(false);
        setError("Failed to connect to WebSocket server. Please try again.");
      };
    } catch (err) {
      console.error("Error creating WebSocket:", err);
      setIsConnecting(false);
      setError(`Connection error: ${err.message}`);
    }
  };

  const setupWebSocketHandlers = (ws) => {
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const data = JSON.parse(event.data);
          console.log("Received message:", data);

          if (data.type === "file-info") {
            handleFileInfo(data);
          } else if (data.type === "file-chunk") {
            // No need to check completion here as it's now handled in handleReceivedChunk
            console.log("Received file chunk metadata");
          } else if (data.type === "transfer-complete") {
            console.log("Server signaled transfer completion");
            completeFileTransfer();
          }
        } catch (e) {
          console.error("Error processing message:", e);
        }
      } else if (event.data instanceof ArrayBuffer) {
          handleReceivedChunk(event.data);
      } else if (event.data instanceof Blob) {
          const reader = new FileReader();
          reader.onload = (e) => {
            if (reader.result) {
              handleReceivedChunk(reader.result as ArrayBuffer);
            }
          };
          reader.onerror = (error) => {
            console.error("Error reading blob data:", error);
            setError("Failed to process received file chunk");
          };
          reader.readAsArrayBuffer(event.data);
      }
    };
    
    ws.onclose = (event) => {
      setIsConnected(false);
      setIsConnecting(false);
      console.log(`WebSocket closed with code ${event.code}`);
      
      // Don't attempt to reconnect if we already have the file or we're closing normally
      if (event.code !== 1000 && !fileUrl) {
        console.warn("WebSocket closed unexpectedly:", event);
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          console.log(`Reconnecting attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS}`);
          setTimeout(() => {
            connectWebSocket();
          }, RECONNECT_DELAY);
        } else {
          setError("Failed to reconnect after multiple attempts.");
        }
      }
    };
  };

  const completeFileTransfer = () => {
    try {
      // Verify we received some data
      if (receivedChunksRef.current.length === 0) {
        throw new Error("No data received - transfer failed");
      }

      const blob = new Blob(receivedChunksRef.current, {
        type: "application/octet-stream",
      });

      if (blob.size === 0) {
        throw new Error("Received empty file");
      }

      const url = URL.createObjectURL(blob);
      setFileUrl(url);
      
      // Important: Send confirmation back to sender that we've received the file
      // This helps unblock the sender who's waiting for recipient connection
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        console.log("Sending transfer-complete confirmation back to sender");
        wsRef.current.send(JSON.stringify({
          type: "transfer-complete",
          target_id: senderId,
          success: true,
          size: blob.size,
          receivedChunks: receivedChunksRef.current.length
        }));
        
        // Send notification again after a short delay in case the first was missed
        setTimeout(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "transfer-complete",
              target_id: senderId,
              success: true
            }));
          }
        }, 500);
      }

      setError(null);
    } catch (e) {
      console.error(`Error completing transfer: ${e}`);
      setError(`Failed to process file: ${e.message}`);
      
      // Also notify sender about failure if possible
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: "transfer-error",
          target_id: senderId,
          error: e.message
        }));
      }
    }
  };

  const downloadFile = () => {
    if (!fileUrl || !fileMetadata) return;

    const a = document.createElement("a");
    a.href = fileUrl;
    a.download = fileMetadata.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Revoke the object URL after download to free memory
    setTimeout(() => {
      URL.revokeObjectURL(fileUrl);
      console.log("File URL revoked after download");
    }, 1000);
  };

  // Clean up WebSocket connection on unmount
  useEffect(() => {
    // Try to connect automatically if we have sender ID
    if (senderId && !isConnected && !isConnecting) {
      connectWebSocket();
    }
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [senderId]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="container flex items-center justify-between p-4">
        <Link href="/">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
            <span className="sr-only">Back</span>
          </Button>
        </Link>
        <ThemeToggle />
      </header>

      {/* Main content */}
      <main className="flex-1 container flex flex-col items-center justify-center py-8 max-w-md">
        <div className="w-full space-y-8">
          {!senderId ? (
            <>
              <div className="text-center space-y-4">
                <div className="w-12 h-12 mx-auto rounded-full bg-secondary flex items-center justify-center">
                  <WifiIcon className="h-6 w-6" />
                </div>
                <h1 className="text-2xl font-bold">No Transfer ID</h1>
                <p className="text-muted-foreground">
                  You need a transfer ID to receive files. Ask the sender to
                  generate a link.
                </p>
                <Link href="/" className="inline-block mt-2">
                  <Button>Go to Home</Button>
                </Link>
              </div>
            </>
          ) : !isConnected && !isConnecting ? (
            <>
              <div className="text-center space-y-2">
                <h1 className="text-2xl font-bold">Ready to Receive</h1>
                <p className="text-muted-foreground">
                  Connect to the server to receive the file
                </p>
              </div>

              <div className="flex flex-col items-center my-6">
                <WifiAnimation active={false} />

                {error && (
                  <div className="w-full p-4 bg-red-100 dark:bg-red-900/30 rounded-lg flex items-start space-x-3">
                    <AlertCircleIcon className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
                    <p className="text-sm text-red-800 dark:text-red-200">
                      {error}
                    </p>
                  </div>
                )}
              </div>

              <div className="text-center mb-6">
                <div className="inline-block px-4 py-2 rounded-lg bg-secondary text-sm">
                  Transfer ID: {senderId}
                </div>
              </div>

              <Button className="w-full" onClick={connectWebSocket}>
                Connect to Server
              </Button>
            </>
          ) : isConnecting ? (
            <>
              <div className="text-center space-y-4">
                <div className="w-12 h-12 mx-auto rounded-full bg-secondary flex items-center justify-center">
                  <Loader2Icon className="h-6 w-6 animate-spin" />
                </div>
                <h1 className="text-2xl font-bold">Connecting...</h1>
                <p className="text-muted-foreground">
                  Establishing secure WebSocket connection with the server
                </p>
              </div>
            </>
          ) : fileUrl ? (
            <>
              <div className="text-center space-y-4">
                <div className="w-12 h-12 mx-auto rounded-full bg-secondary flex items-center justify-center">
                  <CheckIcon className="h-6 w-6" />
                </div>
                <h1 className="text-2xl font-bold">Transfer Complete</h1>
                <p className="text-muted-foreground">
                  {fileMetadata?.name} (
                  {(fileMetadata?.size
                    ? fileMetadata.size / 1024 / 1024
                    : 0
                  ).toFixed(2)}{" "}
                  MB)
                </p>
              </div>

              <Button className="w-full" onClick={downloadFile}>
                <DownloadIcon className="mr-2 h-4 w-4" />
                Download File
              </Button>
            </>
          ) : (
            <>
              <div className="text-center space-y-2">
                <h1 className="text-2xl font-bold">Receiving File</h1>
                {fileMetadata && (
                  <p className="text-muted-foreground">
                    {fileMetadata.name} (
                    {(fileMetadata.size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                )}
              </div>

              <div className="flex flex-col items-center my-6">
                <WifiAnimation active={true} />
              </div>

              <div className="w-full space-y-4">
                <div className="flex justify-between text-sm">
                  <span>Transferring...</span>
                  <span>{transferProgress}%</span>
                </div>
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${transferProgress}%` }}
                  ></div>
                </div>

                <div className="flex items-center justify-center mt-4 text-sm text-muted-foreground p-3 rounded-lg bg-secondary">
                  <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
                  <span>Please keep this window open</span>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
