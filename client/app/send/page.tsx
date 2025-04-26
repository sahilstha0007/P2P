"use client";

import type React from "react";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WifiAnimation } from "@/components/wifi-animation";
import { FileCard } from "@/components/file-card";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  FileIcon,
  CopyIcon,
  CheckIcon,
  ArrowLeft,
  SendIcon,
  LinkIcon,
  Loader2Icon,
  BellIcon,
} from "lucide-react";
import { generateId } from "@/lib/utils";
import Link from "next/link";

export default function SendPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileSending, setFileSending] = useState(false);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [transferProgress, setTransferProgress] = useState(0);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [notification, setNotification] = useState<{message: string, type: 'success'|'error'|'info', visible: boolean}>({
    message: '',
    type: 'info',
    visible: false
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recipientIdRef = useRef<string | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY = 3000;

  // Add a transfer timeout mechanism
  const transferTimeoutRef = useRef<any>(null);
  
  // Add a ref to track the transfer ID to avoid state timing issues
  const transferIdRef = useRef<string | null>(null);

  // Helper function to show notifications instead of alerts
  const showNotification = (message: string, type: 'success'|'error'|'info' = 'info') => {
    setNotification({
      message,
      type,
      visible: true
    });
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
      setNotification(prev => ({...prev, visible: false}));
    }, 5000);
  };
  
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const checkForRecipient = () => {
    if (!transferId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    console.log("Checking for recipient connection...");
    // Send a ping to check if any recipients are waiting
    wsRef.current.send(
      JSON.stringify({
        type: "check-recipient",
        connectionId: transferId,
        requestStatus: true
      })
    );
  };

  const connectWebSocket = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log("WebSocket already connected");
      return wsRef.current;
    }
    
    if (wsRef.current && wsRef.current.readyState === WebSocket.CONNECTING) {
      console.log("WebSocket connection in progress");
      return wsRef.current;
    }

    console.log("Attempting to establish WebSocket connection...");
    setIsGeneratingLink(true);
    
    // Use only the connection URL that works based on logs
    const wsUrl = `ws://localhost:3000/ws`;
    console.log("Connecting to WebSocket server at:", wsUrl);
    
    // Show connecting message to user for feedback
    const connectionStatusDiv = document.createElement('div');
    connectionStatusDiv.id = 'connection-status';
    connectionStatusDiv.style.position = 'fixed';
    connectionStatusDiv.style.bottom = '10px';
    connectionStatusDiv.style.right = '10px';
    connectionStatusDiv.style.backgroundColor = 'rgba(0,0,0,0.7)';
    connectionStatusDiv.style.color = 'white';
    connectionStatusDiv.style.padding = '8px 12px';
    connectionStatusDiv.style.borderRadius = '4px';
    connectionStatusDiv.style.fontSize = '12px';
    connectionStatusDiv.style.zIndex = '9999';
    connectionStatusDiv.textContent = 'Connecting to server...';
    document.body.appendChild(connectionStatusDiv);
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log(`✅ Connection successful with: ${wsUrl}`);
        reconnectAttemptsRef.current = 0;
        const connectionId = generateId();
        console.log("Generated transfer ID:", connectionId);
        
        // Store ID in both state and ref for consistent access
        transferIdRef.current = connectionId;
        setTransferId(connectionId);
        setIsGeneratingLink(false);
  
        // Send registration immediately using the ref
        ws.send(
          JSON.stringify({
            type: "register",
            connectionId: connectionId,
          })
        );
        console.log("Sent registration message with ID:", connectionId);
        
        connectionStatusDiv.textContent = 'Connected successfully!';
        connectionStatusDiv.style.backgroundColor = 'rgba(0,128,0,0.7)';
        setTimeout(() => {
          if (document.body.contains(connectionStatusDiv)) {
            document.body.removeChild(connectionStatusDiv);
          }
        }, 1500);
      };
      
      ws.onerror = (event) => {
        console.log(`Connection failed to ${wsUrl}`);
        connectionStatusDiv.textContent = 'Connection failed';
        connectionStatusDiv.style.backgroundColor = 'rgba(220,0,0,0.7)';
        setTimeout(() => {
          if (document.body.contains(connectionStatusDiv)) {
            document.body.removeChild(connectionStatusDiv);
          }
        }, 3000);
        setIsGeneratingLink(false);
      };
      
      // Continue setting up other event handlers
      setupWebSocketHandlers(ws);
      
    } catch (err) {
      console.log(`Could not create connection to ${wsUrl}:`, err.message);
      connectionStatusDiv.textContent = 'Connection failed';
      connectionStatusDiv.style.backgroundColor = 'rgba(220,0,0,0.7)';
      setTimeout(() => {
        if (document.body.contains(connectionStatusDiv)) {
          document.body.removeChild(connectionStatusDiv);
        }
      }, 3000);
      setIsGeneratingLink(false);
    }
    
    return wsRef.current;
  };

  const setupWebSocketHandlers = (ws) => {
    // Add ping/pong to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch (err) {
          console.log("Ping failed, connection may be dead");
        }
      } else {
        // Clear interval if websocket is no longer open
        clearInterval(pingInterval);
      }
    }, 30000); // Every 30 seconds

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const data = JSON.parse(event.data);
          
          // Debug all messages except pings to trace communication issues
          if (data.type !== "ping" && data.type !== "pong") {
            console.log(`[${new Date().toISOString()}] RECEIVED: ${data.type}`, data);
          }
          
          // Handle receiver-ready messages with robust id matching
          if (data.type === "receiver-ready") {
            // Log complete message for debugging
            console.log("%cRECEIVER CONNECTED MESSAGE:", "color:green;font-weight:bold", JSON.stringify(data));
            
            // Get current transferId from both state and ref to ensure it's available
            const currentTransferId = transferIdRef.current || transferId;
            console.log("Current transferId check:", { 
              fromState: transferId, 
              fromRef: transferIdRef.current, 
              using: currentTransferId 
            });
            
            // More flexible ID matching logic
            const matchesSenderId = data.senderId === currentTransferId;
            const matchesTargetId = data.target_id === currentTransferId;
            
            console.log(`ID match check - senderId match: ${matchesSenderId}, targetId match: ${matchesTargetId}`);
            
            // Additional logging to diagnose matching issues
            if (!matchesSenderId && !matchesTargetId) {
              console.log("No direct match, checking partial matches...");
              // Try more lenient matching as a fallback
              const senderIdIncludes = currentTransferId && data.senderId && 
                                    (data.senderId.includes(currentTransferId) || 
                                     currentTransferId.includes(data.senderId));
              
              const targetIdIncludes = currentTransferId && data.target_id &&
                                    (data.target_id.includes(currentTransferId) || 
                                     currentTransferId.includes(data.target_id));
                                     
              console.log(`Partial matches: senderIdIncludes=${senderIdIncludes}, targetIdIncludes=${targetIdIncludes}`);
              
              // Accept partial matches if we have no direct match
              if (senderIdIncludes || targetIdIncludes) {
                console.log("Accepting connection based on partial ID match");
                // Extract recipient ID from message with fallbacks
                recipientIdRef.current = data.receiverId || data.connectionId || data.target_id;
                console.log(`✅ RECIPIENT CONNECTED via partial match: ${recipientIdRef.current}`);
                setIsConnected(true);
                showNotification("Recipient connected! You can now send the file.", "success");
                return;
              }
            }
            
            // Regular exact matching logic
            if (matchesSenderId || matchesTargetId) {
              // Extract recipient ID from message with fallbacks
              recipientIdRef.current = data.receiverId || data.connectionId || data.target_id;
              console.log(`✅ RECIPIENT CONNECTED: ${recipientIdRef.current}`);
              
              // Update connection state
              setIsConnected(true);
              
              // Use custom notification instead of alert
              showNotification("Recipient connected! You can now send the file.", "success");
            } else {
              // Add additional logging to help diagnose the issue
              console.warn("ID mismatch in receiver-ready message", { 
                ourId: currentTransferId, 
                receivedSenderId: data.senderId,
                receivedTargetId: data.target_id 
              });
            }
          } else if (data.type === "registered") {
            // When registration confirmation is received, ensure we're consistently using the server-confirmed ID
            if (data.id) {
              console.log(`Server confirmed registration with ID: ${data.id}`);
              // Update both state and ref
              transferIdRef.current = data.id;
              setTransferId(data.id);
              console.log("Updated transferId in state and ref:", data.id);
            }
          } else if (data.type === "transfer-complete" || data.type === "file-transfer-complete") {
            console.log("Transfer complete notification received");
            setTransferProgress(100);
            showNotification("File transfer completed successfully!", "success");
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      }
    };
    
    ws.onclose = (event) => {
      // Clear ping interval when connection closes
      clearInterval(pingInterval);
      
      console.log(`WebSocket closed with code: ${event.code}, reason: ${event.reason}`);
      setIsConnected(false);
      
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error("Max reconnect attempts reached. No longer trying to reconnect.");
        return;
      }
      
      reconnectAttemptsRef.current++;
      console.log(`Reconnect attempt ${reconnectAttemptsRef.current} of ${MAX_RECONNECT_ATTEMPTS}`);
      
      // Use exponential backoff for reconnects
      const delay = RECONNECT_DELAY * Math.pow(1.5, reconnectAttemptsRef.current - 1);
      console.log(`Waiting ${delay}ms before reconnecting...`);
      setTimeout(() => {
        connectWebSocket();
      }, delay);
    };
  };

  const generateReceiverLink = async () => {
    if (!file) return;
    setIsGeneratingLink(true);
    
    try {
      connectWebSocket();
    } catch (error) {
      setIsGeneratingLink(false);
    }
  };

  const copyLink = () => {
    if (!transferId) return;
    const link = `${window.location.origin}/receive?id=${transferId}`;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(link)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch((err) => {
          console.error("Clipboard copy failed:", err);
        });
    } else {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = link;
      textArea.style.position = "absolute";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Fallback copy failed:", err);
        alert("Failed to copy. Try manually selecting and copying the text.");
      }
      document.body.removeChild(textArea);
    }
  };

  const sendFile = () => {
    if (!file || !wsRef.current || !recipientIdRef.current) return;
    
    // Check WebSocket connection state
    if (wsRef.current.readyState !== WebSocket.OPEN) {
      console.error("WebSocket not open, cannot send file");
      showNotification("Connection lost. Please refresh and try again.", "error");
      return;
    }
    
    setFileSending(true);
    console.log(`Starting file transfer to recipient: ${recipientIdRef.current}`);
    
    // Use smaller chunks for better performance
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    let offset = 0;
    let chunkCount = 0;
    let lastProgressUpdate = Date.now();
    const PROGRESS_UPDATE_INTERVAL = 100; // Update progress UI every 100ms
    const reader = new FileReader();

    // Send file info to receiver
    wsRef.current.send(
      JSON.stringify({
        target_id: recipientIdRef.current,
        type: "file-info",
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      })
    );

    reader.onload = (e) => {
      if (!e.target?.result || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      
      const chunkData = new Uint8Array(e.target.result as ArrayBuffer);
      
      // First send metadata about the chunk
      wsRef.current.send(
        JSON.stringify({
          target_id: recipientIdRef.current,
          type: "file-chunk",
          chunkNumber: chunkCount,
          chunkSize: chunkData.length,
        })
      );
      
      // Then send the binary data
      wsRef.current.send(chunkData.buffer);
      
      offset += chunkData.length;
      chunkCount++;

      // Log every 10% of progress - Fixed reference to fileSizeRef
      if (file.size > 0 && offset % Math.floor(file.size / 10) < CHUNK_SIZE) {
        console.log(`Transfer progress: ${Math.floor((offset / file.size) * 100)}%`);
      }

      // Update progress less frequently to improve performance
      const now = Date.now();
      if (now - lastProgressUpdate > PROGRESS_UPDATE_INTERVAL || offset >= file.size) {
        const progress = Math.min(100, Math.floor((offset / file.size) * 100));
        setTransferProgress(progress);
        lastProgressUpdate = now;
      }

      if (offset < file.size) {
        // Reset timeout on each chunk
        if (transferTimeoutRef.current) {
          clearTimeout(transferTimeoutRef.current);
        }
        
        transferTimeoutRef.current = setTimeout(() => {
          if (fileSending && transferProgress < 100) {
            console.warn("File transfer appears to be stalled");
          }
        }, 30000);
        
        // Use setTimeout with 0 to avoid blocking the UI thread
        setTimeout(() => {
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          reader.readAsArrayBuffer(slice);
        }, 0);
      } else {
        // Clear timeout when transfer completes
        if (transferTimeoutRef.current) {
          clearTimeout(transferTimeoutRef.current);
          transferTimeoutRef.current = null;
        }
        
        // Transfer complete
        wsRef.current.send(
          JSON.stringify({
            target_id: recipientIdRef.current,
            type: "file-transfer-complete",
            chunkCount: chunkCount,
            totalBytes: file.size,
          })
        );
        
        // Also send with alternative type for compatibility
        wsRef.current.send(
          JSON.stringify({
            target_id: recipientIdRef.current,
            type: "transfer-complete",
            chunkCount: chunkCount,
            totalBytes: file.size,
          })
        );
        
        setTransferProgress(100);
        setFileSending(false);
      }
    };

    reader.onerror = (e) => {
      console.error("Error reading file:", e);
      setFileSending(false);
      alert("Error reading file. Please try again.");
    };

    // Start reading the first chunk
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  };

  // Clean up WebSocket connection on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (transferTimeoutRef.current) {
        clearTimeout(transferTimeoutRef.current);
      }
    };
  }, []);

  // Update the effect to use the ref for checking
  useEffect(() => {
    let checkInterval = null;
    const currentTransferId = transferIdRef.current || transferId;
    
    if (currentTransferId && !isConnected) {
      console.log("Setting up recipient check interval with ID:", currentTransferId);
      
      // Run an initial check immediately
      setTimeout(() => {
        if (!isConnected && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          console.log("Initial recipient check with ID:", currentTransferId);
          wsRef.current.send(
            JSON.stringify({
              type: "check-recipient",
              connectionId: currentTransferId,
              requestStatus: true
            })
          );
        }
      }, 500);
      
      // Then set up periodic checks
      checkInterval = setInterval(() => {
        if (!isConnected && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          console.log("Periodic recipient check with ID:", currentTransferId);
          wsRef.current.send(
            JSON.stringify({
              type: "check-recipient",
              connectionId: currentTransferId,
              requestStatus: true
            })
          );
        }
      }, 3000);
    }

    return () => {
      if (checkInterval) {
        clearInterval(checkInterval);
      }
    };
  }, [transferId, isConnected]);

  // Update effect for transferId to sync with ref
  useEffect(() => {
    if (transferId) {
      console.log("TransferId state updated:", transferId);
      transferIdRef.current = transferId;
    }
  }, [transferId]);

  return (
    <div className="min-h-screen flex flex-col gradient-bg">
      {/* Header */}
      <header className="container flex items-center justify-between p-4">
        <Link href="/">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full hover:bg-secondary/80"
          >
            <ArrowLeft className="h-5 w-5" /> 
            <span className="sr-only">Back</span>
          </Button>
        </Link>
        <ThemeToggle />
      </header>

      {/* Notification Toast */}
      {notification.visible && (
        <div 
          className={`fixed top-4 right-4 z-50 p-4 rounded-lg shadow-lg flex items-center gap-2 transition-all ${
            notification.type === 'success' ? 'bg-green-600 text-white' : 
            notification.type === 'error' ? 'bg-red-600 text-white' : 
            'bg-blue-600 text-white'
          }`}
        >
          {notification.type === 'success' && <CheckIcon className="h-5 w-5" />}
          {notification.type === 'error' && <BellIcon className="h-5 w-5" />}
          {notification.type === 'info' && <BellIcon className="h-5 w-5" />}
          <span>{notification.message}</span>
          <button 
            onClick={() => setNotification(prev => ({...prev, visible: false}))}
            className="ml-4 hover:opacity-80"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="container flex flex-col flex-1 items-center justify-center mx-auto p-4">
        {/* Add missing file input element */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          aria-hidden="true"
        />
        
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="flex flex-col items-center justify-center space-y-3"
        >
          <h1 className="text-3xl font-bold">Send a File</h1>
          <p className="text-muted-foreground">
            Select a file to share it securely via WebSocket
          </p>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border border-border/50 rounded-xl p-10 text-center cursor-pointer hover:bg-secondary/50 transition-all group"
          >
            <div className="w-16 h-16 mx-auto rounded-xl bg-secondary/80 flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
              <FileIcon className="h-7 w-7" />
            </div>
            <p className="text-base font-medium mb-1">
              Drag and drop your file here
            </p>
            <p className="text-sm text-muted-foreground">
              or click to browse
            </p>
          </div>
        </div>

        {file && !transferId && (
          <div className="text-center space-y-3">
            <h1 className="text-3xl font-bold">File Selected</h1>
            <p className="text-muted-foreground mb-4">
              Ready to generate a transfer link
            </p>
            <FileCard file={file} className="mb-6" />
            <Button
              className="w-full py-6 rounded-xl hover-lift"
              onClick={generateReceiverLink}
              disabled={isGeneratingLink}
            >
              <LinkIcon className="mr-2 h-5 w-5" />
              Generate Transfer Link
              {isGeneratingLink ? (
                <>
                  <Loader2Icon className="mr-2 h-5 w-5 animate-spin" />
                  Generating Link...
                </>
              ) : null}
            </Button>
          </div>
        )}

        {file && transferId && (
          <>
            <div className="text-center space-y-3">
              <h1 className="text-3xl font-bold">Ready to Transfer</h1>
              <p className="text-muted-foreground mb-4">
                Share this link with the recipient
              </p>
            </div>

            <div className="flex flex-col items-center mb-6">
              <WifiAnimation active={isConnected} />
              {isConnected && (
                <div className="mt-2 text-sm font-medium text-green-600 dark:text-green-400">
                  ✓ Recipient connected
                </div>
              )}
            </div>

            <div className="flex w-full mb-6">
              <div className="relative flex-1">
                <div className="flex">
                  <Input
                    value={`${window.location.origin}/receive?id=${transferId}`}
                    className="pr-10 rounded-r-none border-r-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                    disabled={isGeneratingLink}
                    readOnly
                  />
                  <Button
                    variant="secondary"
                    size="icon"
                    className="rounded-l-none"
                    onClick={copyLink}
                  >
                    {copied ? (
                      <CheckIcon className="h-4 w-4 text-green-500" />
                    ) : (
                      <CopyIcon className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <div className="text-muted-foreground mb-4">
              <FileCard file={file} className="mb-6" />

              {isConnected ? (
                <div className="w-full space-y-4">
                  {transferProgress > 0 ? (
                    <div className="space-y-3">
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
                    </div>
                  ) : (
                    <Button
                      className="w-full py-6 rounded-xl hover-lift"
                      onClick={sendFile}
                      disabled={fileSending}
                    >
                      <SendIcon className="mr-2 h-5 w-5" />
                      Send File
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center space-x-2 text-sm text-muted-foreground p-4 rounded-xl bg-secondary/50 glass">
                  <div className="dot-pulse"></div>
                  <span className="ml-6">
                    Waiting for recipient to connect...
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
