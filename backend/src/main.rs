use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::{
    sync::{broadcast, mpsc, Mutex},
    time::interval,
};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    connections: Arc<Mutex<HashMap<String, broadcast::Sender<Message>>>>,
}

#[tokio::main]
async fn main() {
    let state = AppState {
        connections: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    println!("Server running at ws://{}", addr);
    
    // In Axum 0.8+ with Hyper 1.x, we use this pattern instead
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let conn_id = Uuid::new_v4().to_string();
    println!("New connection: {}", conn_id);

    let (tx, _) = broadcast::channel(100);
    {
        let mut connections = state.connections.lock().await;
        connections.insert(conn_id.clone(), tx.clone());
    }

    let (mut sender, mut receiver) = socket.split();
    let (message_tx, mut message_rx) = mpsc::channel::<Message>(100);

    // Task to forward messages from the channel to the WebSocket
    let sender_task = {
        let conn_id = conn_id.clone();  // Clone conn_id before moving it
        tokio::spawn(async move {
            while let Some(message) = message_rx.recv().await {
                if sender.send(message).await.is_err() {
                    println!("Error sending message to client {}", conn_id);
                    break;
                }
            }
        })
    };

    // Subscribe to the broadcast channel for this connection
    let broadcast_forward_task = {
        let mut rx = tx.subscribe();
        let message_tx = message_tx.clone();
        let conn_id = conn_id.clone();
        
        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                println!("Connection {} received broadcast message", conn_id);
                if message_tx.send(msg).await.is_err() {
                    println!("Error forwarding broadcast message to {}", conn_id);
                    break;
                }
            }
        })
    };

    // Task to send periodic pings
    let ping_tx = message_tx.clone();
    let ping_task = tokio::spawn(async move {
        let mut interval = interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            if ping_tx.send(Message::Ping(vec![].into())).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages
    let receive_task = {
        let state = state.clone();
        let conn_id = conn_id.clone();
        let mut target_map: HashMap<String, String> = HashMap::new();
        let message_tx = message_tx.clone();

        tokio::spawn(async move {
            while let Some(Ok(msg)) = receiver.next().await {
                match msg {
                    // For text messages, try to parse as JSON and handle accordingly
                    Message::Text(text) => {
                        println!("Received text message from {}: {}", conn_id, text);
                        if let Ok(data) = serde_json::from_str::<Value>(&text) {
                            if data["type"] == "register" {
                                if let Some(id) = data["connectionId"].as_str() {
                                    println!("Registering connection with custom ID: {}", id);
                                    // Store the broadcaster with the custom ID
                                    state.connections.lock().await.insert(id.to_string(), tx.clone());
                                    // Also maintain the original UUID mapping
                                    let _ = message_tx.send(Message::Text(format!("{{\"type\":\"registered\",\"id\":\"{}\"}}", id).into())).await;
                                    println!("Registration confirmation sent for ID: {}", id);
                                }
                                continue;
                            }
                            
                            // Handle check-recipient messages
                            if data["type"] == "check-recipient" {
                                if let Some(check_id) = data["connectionId"].as_str() {
                                    println!("Client {} checking for recipients with ID: {}", conn_id, check_id);
                                    
                                    // Check if any connection exists with this ID
                                    let connections = state.connections.lock().await;
                                    if connections.contains_key(check_id) {
                                        println!("Connection {} exists in registry", check_id);
                                    } else {
                                        println!("No connection found with ID: {}", check_id);
                                    }
                                }
                                continue; 
                            }
                            
                            if data["type"] == "receiver-ready" {
                                println!("Receiver ready message from {}: {}", conn_id, text);
                                // Ensure we forward this important message correctly
                                if let Some(target_id) = data["senderId"].as_str() {
                                    println!("Forwarding receiver-ready to sender: {}", target_id);
                                    if let Some(target_tx) = state.connections.lock().await.get(target_id) {
                                        match target_tx.send(Message::Text(text.clone())) {
                                            Ok(_) => println!("Receiver-ready forwarded to {}", target_id),
                                            Err(e) => println!("Error forwarding receiver-ready: {}", e),
                                        }
                                    } else {
                                        println!("Target sender {} not found for receiver-ready message", target_id);
                                    }
                                }
                                continue;
                            }
                            
                            if let Some(target_id) = data["target_id"].as_str() {
                                println!("Connection {} targeting {}", conn_id, target_id);
                                target_map.insert(conn_id.clone(), target_id.to_string());
                                if let Some(target_tx) = state.connections.lock().await.get(target_id) {
                                    match target_tx.send(Message::Text(text.clone())) {
                                        Ok(_) => println!("Message forwarded to {}", target_id),
                                        Err(e) => println!("Error forwarding message to {}: {}", target_id, e),
                                    }
                                } else {
                                    println!("Target {} not found", target_id);
                                    let _ = message_tx.send(Message::Text(format!("{{\"type\":\"error\",\"message\":\"Target {} not found\"}}", target_id).into())).await;
                                }
                            }
                        }
                    }
                    // For binary messages, forward to the target if set
                    Message::Binary(bin_data) => {
                        if let Some(target_id) = target_map.get(&conn_id) {
                            println!("Forwarding binary data from {} to {}", conn_id, target_id);
                            if let Some(target_tx) = state.connections.lock().await.get(target_id) {
                                match target_tx.send(Message::Binary(bin_data.clone())) {
                                    Ok(_) => println!("Binary data forwarded to {}", target_id),
                                    Err(e) => println!("Error forwarding binary data: {}", e),
                                }
                            }
                        } else {
                            println!("No target set for binary transfer from {}", conn_id);
                            let _ = message_tx.send(Message::Text(format!("{{\"type\":\"error\",\"message\":\"No target set for binary transfer\"}}").into())).await;
                        }
                    }
                    Message::Close(_) => {
                        println!("Close message received from {}", conn_id);
                        break;
                    }
                    // Forward any other messages back to the WebSocket sender
                    other_msg => {
                        let _ = message_tx.send(other_msg).await;
                    }
                }
            }
        })
    };

    // Wait for any task to complete
    tokio::select! {
        _ = sender_task => { println!("Sender task ended for {}", conn_id); },
        _ = broadcast_forward_task => { println!("Broadcast task ended for {}", conn_id); },
        _ = ping_task => { println!("Ping task ended for {}", conn_id); },
        _ = receive_task => { println!("Receive task ended for {}", conn_id); },
    }

    // Clean up the connection
    state.connections.lock().await.remove(&conn_id);
    println!("Connection closed: {}", conn_id);
}