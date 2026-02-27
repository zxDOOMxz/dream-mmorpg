import asyncio
import json
import os
from datetime import datetime, timedelta
from typing import Optional

import asyncpg
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from passlib.context import CryptContext
from jose import jwt, JWTError
from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
SECRET_KEY = os.getenv("SECRET_KEY", "fallback-secret")
ALGORITHM = "HS256"

app = FastAPI(title="DreamMMORPG API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()

db_pool = None

@app.on_event("startup")
async def startup():
    global db_pool
    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    print("✅ БД подключена")

@app.on_event("shutdown")
async def shutdown():
    await db_pool.close()

# ========== МОДЕЛИ ==========
class RegisterModel(BaseModel):
    login: str
    email: str
    password: str
class LoginModel(BaseModel):
    login: str
    password: str

class CreateCharacterModel(BaseModel):
    name: str
    race: str = "human"
    char_class: str = "warrior"

# ========== УТИЛИТЫ ==========
def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def create_token(user_id: int) -> str:
    expire = datetime.utcnow() + timedelta(hours=24)
    return jwt.encode({"sub": str(user_id), "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get("sub"))
        return user_id
    except JWTError:
        raise HTTPException(status_code=401, detail="Неверный токен")

# ========== РОУТЫ ==========
@app.get("/")
async def root():
    return {"status": "ok", "game": "DreamMMORPG", "version": "0.1"}

@app.post("/register")
async def register(data: RegisterModel):
    async with db_pool.acquire() as conn:
        existing = await conn.fetchrow("SELECT id FROM users WHERE login=$1 OR email=$2", data.login, data.email)
        if existing:
            raise HTTPException(status_code=400, detail="Логин или email уже занят")
        user_id = await conn.fetchval(
            "INSERT INTO users (login, password_hash) VALUES ($1, $2) RETURNING id",
                data.login, hash_password(data.password)        )
        token = create_token(user_id)
        return {"status": "ok", "token": token, "user_id": user_id}

@app.post("/login")
async def login(data: LoginModel):
    async with db_pool.acquire() as conn:
        user = await conn.fetchrow("SELECT id, password_hash FROM users WHERE login=$1", data.login)
        if not user or not verify_password(data.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")
        await conn.execute("UPDATE users SET last_login=NOW() WHERE id=$1", user["id"])
        token = create_token(user["id"])
        return {"status": "ok", "token": token, "user_id": user["id"]}

@app.post("/character/create")
async def create_character(data: CreateCharacterModel, user_id: int = Depends(get_current_user)):
    async with db_pool.acquire() as conn:
        existing = await conn.fetchrow("SELECT id FROM characters WHERE name=$1", data.name)
        if existing:
            raise HTTPException(status_code=400, detail="Имя персонажа уже занято")
        char_id = await conn.fetchval(
            """INSERT INTO characters (user_id, name, race, class, location_id)
               VALUES ($1, $2, $3, $4, 1) RETURNING id""",
            user_id, data.name, data.race, data.char_class
        )
        return {"status": "ok", "character_id": char_id}

@app.get("/character")
async def get_character(user_id: int = Depends(get_current_user)):
    async with db_pool.acquire() as conn:
        char = await conn.fetchrow(
            "SELECT * FROM characters WHERE user_id=$1 ORDER BY id LIMIT 1", user_id
        )
        if not char:
            raise HTTPException(status_code=404, detail="Персонаж не найден")
        return dict(char)

@app.get("/locations")
async def get_locations():
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM locations")
        return [dict(r) for r in rows]

@app.get("/items")
async def get_items():
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM items ORDER BY type, req_level")
        return [dict(r) for r in rows]

@app.get("/quests")
async def get_quests():
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM quests ORDER BY req_level")
        return [dict(r) for r in rows]

# ========== WEBSOCKET ==========
connected_players = {}

@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    user_id = None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get("sub"))
    except JWTError:
        await websocket.send_json({"type": "error", "message": "Неверный токен"})
        await websocket.close()
        return

    async with db_pool.acquire() as conn:
        char = await conn.fetchrow("SELECT * FROM characters WHERE user_id=$1 LIMIT 1", user_id)

    if not char:
        await websocket.send_json({"type": "error", "message": "Создайте персонажа"})
        await websocket.close()
        return

    char_name = char["name"]
    connected_players[user_id] = {"ws": websocket, "name": char_name, "char": dict(char)}
    print(f"🟢 {char_name} подключился")

    await websocket.send_json({
        "type": "welcome",
        "message": f"Добро пожаловать, {char_name}!",
        "character": dict(char),
        "online": len(connected_players)
    })

    await broadcast({"type": "system", "message": f"{char_name} вошёл в игру"}, exclude=user_id)

    try:
        while True:
            data = await websocket.receive_json()
            await handle_message(user_id, char_name, data)
    except WebSocketDisconnect:
        connected_players.pop(user_id, None)
        await broadcast({"type": "system", "message": f"{char_name} покинул игру"})
        print(f"🔴 {char_name} отключился")

async def handle_message(user_id: int, char_name: str, data: dict):
    msg_type = data.get("type")

    if msg_type == "chat":
        channel = data.get("channel", "local")
        message = data.get("message", "")[:200]
        if not message.strip():
            return
        async with db_pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO chat_logs (channel, sender_id, sender_name, message) VALUES ($1, $2, $3, $4)",
                channel, user_id, char_name, message
            )
        await broadcast({
            "type": "chat",
            "channel": channel,
            "sender": char_name,
            "message": message,
            "time": datetime.utcnow().isoformat()
        })

    elif msg_type == "ping":
        ws = connected_players[user_id]["ws"]
        await ws.send_json({"type": "pong"})

async def broadcast(data: dict, exclude: Optional[int] = None):
    dead = []
    for uid, player in connected_players.items():
        if uid == exclude:
            continue
        try:
            await player["ws"].send_json(data)
        except:
            dead.append(uid)
    for uid in dead:
        connected_players.pop(uid, None)
