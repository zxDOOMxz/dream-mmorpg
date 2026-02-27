const API='https://dream-mmorpg-production.up.railway.app';
const WSURL='wss://dream-mmorpg-production.up.railway.app/ws';
let token=localStorage.getItem('token');
let username=localStorage.getItem('username');
let userId=null;
let myChar=null;
let selectedClass='warrior';
let ws=null;
let otherPlayers={};
let canvas,ctx;
let locations=[];

if(!token){window.location.href='index.html';}

function logout(){
  localStorage.clear();
  if(ws)ws.close();
  window.location.href='index.html';
}

window.addEventListener('load',async()=>{
  canvas=document.getElementById('gameCanvas');
  ctx=canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize',resizeCanvas);
  
  await loadCharacter();
  await loadLocations();
  if(!myChar){
    document.getElementById('createCharOverlay').style.display='flex';
  }else{
    connectWS();
    startGameLoop();
  }
  
  canvas.addEventListener('click',onCanvasClick);
  document.getElementById('chatInput').addEventListener('keydown',(e)=>{
    if(e.key==='Enter')sendChat();
  });
});

function resizeCanvas(){
  const area=document.querySelector('.map-area');
  canvas.width=area.clientWidth;
  canvas.height=area.clientHeight;
}

function selectClass(el,cls){
  document.querySelectorAll('.class-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  selectedClass=cls;
}

async function createCharacter(){
  const name=document.getElementById('charName').value.trim();
  if(!name)return showCharMsg('Введите имя персонажа');
  const r=await fetch(API+'/character/create',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({name,character_class:selectedClass})
  });
  const d=await r.json();
  if(r.ok){
    document.getElementById('createCharOverlay').style.display='none';
    await loadCharacter();
    connectWS();
    startGameLoop();
  }else showCharMsg(d.detail||'Ошибка');
}

function showCharMsg(t){
  const el=document.getElementById('char-msg');
  el.textContent=t;
  el.className='message err';
}

async function loadCharacter(){
  const r=await fetch(API+'/character',{headers:{'Authorization':'Bearer '+token}});
  const d=await r.json();
  if(r.ok && d.character_name){
    myChar=d;
    userId=myChar.user_id;
    updateUI();
  }
}

async function loadLocations(){
  const r=await fetch(API+'/locations');
  locations=await r.json();
  renderLocationsList();
}

function renderLocationsList(){
  const el=document.getElementById('locationsList');
  el.innerHTML=locations.map(l=>`<div style="padding:4px;cursor:pointer;color:#9a7acc;font-size:0.8rem;border-radius:3px;margin:2px 0;background:#1a1030" onclick="travelTo(${l.id})">${l.name} [Lv.${l.min_level}]</div>`).join('');
}

function updateUI(){
  if(!myChar)return;
  document.getElementById('topName').textContent=myChar.character_name;
  document.getElementById('hpText').textContent=`${myChar.hp}/${myChar.max_hp}`;
  document.getElementById('hpFill').style.width=(myChar.hp/myChar.max_hp*100)+'%';
  document.getElementById('xpFill').style.width=(myChar.xp/myChar.xp_to_next*100)+'%';
  document.getElementById('lvlText').textContent='Lv.'+myChar.level;
  document.getElementById('goldText').innerHTML='&#9733; '+myChar.gold;
  document.getElementById('sClass').textContent=myChar.character_class;
  document.getElementById('sLvl').textContent=myChar.level;
  document.getElementById('sHp').textContent=myChar.hp+'/'+myChar.max_hp;
  document.getElementById('sAtk').textContent=myChar.attack;
  document.getElementById('sDef').textContent=myChar.defense;
  document.getElementById('sSpd').textContent=myChar.speed;
  const loc=locations.find(l=>l.id===myChar.location_id);
  document.getElementById('sLoc').textContent=loc?loc.name:'-';
  document.getElementById('sPosX').textContent=myChar.x_pos;
  document.getElementById('sPosY').textContent=myChar.y_pos;
}

function connectWS(){
  if(ws)ws.close();
  ws=new WebSocket(WSURL+'/'+userId);
  ws.onopen=()=>{addChatSys('Подключено к серверу')};
  ws.onmessage=(e)=>handleWSMessage(JSON.parse(e.data));
  ws.onclose=()=>addChatSys('Соединение разорвано');
}

function handleWSMessage(msg){
  if(msg.type==='state_update'){
    myChar.x_pos=msg.data.x_pos;
    myChar.y_pos=msg.data.y_pos;
    myChar.location_id=msg.data.location_id;
    updateUI();
  }else if(msg.type==='players'){
    otherPlayers={};
    msg.data.forEach(p=>{
      if(p.user_id!==userId)otherPlayers[p.user_id]=p;
    });
    renderPlayersList();
  }else if(msg.type==='player_moved'){
    if(msg.data.user_id===userId)return;
    if(msg.data.location_id===myChar.location_id){
      if(!otherPlayers[msg.data.user_id])otherPlayers[msg.data.user_id]={character_name:'Player',level:1};
      otherPlayers[msg.data.user_id].x_pos=msg.data.x_pos;
      otherPlayers[msg.data.user_id].y_pos=msg.data.y_pos;
    }
  }else if(msg.type==='chat'){
    addChatMsg(msg.data.user_name,msg.data.message);
  }
}

function renderPlayersList(){
  const list=Object.values(otherPlayers).filter(p=>p.location_id===myChar.location_id);
  const el=document.getElementById('playersList');
  if(!list.length){el.innerHTML='<div style="color:#5a4a6a;font-size:0.8rem">No players here</div>';return;}
  el.innerHTML=list.map(p=>`<div class="player-item"><span class="pname">${p.character_name}</span> <span class="plvl">Lv.${p.level}</span></div>`).join('');
}

function sendChat(){
  const inp=document.getElementById('chatInput');
  const text=inp.value.trim();
  if(!text||!ws)return;
  ws.send(JSON.stringify({type:'chat',message:text}));
  inp.value='';
}

function addChatMsg(name,text){
  const el=document.getElementById('chatMessages');
  const m=document.createElement('div');
  m.className='chat-msg';
  m.innerHTML='<span class="cm-name">'+name+':</span> <span class="cm-text">'+text+'</span>';
  el.appendChild(m);
  el.scrollTop=el.scrollHeight;
}

function addChatSys(text){
  const el=document.getElementById('chatMessages');
  const m=document.createElement('div');
  m.className='chat-msg';
  m.innerHTML='<span class="cm-sys">[SYSTEM]</span> <span class="cm-text">'+text+'</span>';
  el.appendChild(m);
  el.scrollTop=el.scrollHeight;
}

function onCanvasClick(e){
  if(!myChar)return;
  const rect=canvas.getBoundingClientRect();
  const x=Math.floor((e.clientX-rect.left)/20);
  const y=Math.floor((e.clientY-rect.top)/20);
  if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'move',x:x,y:y}));
}

function startGameLoop(){
  setInterval(drawGame,50);
}

function drawGame(){
  ctx.fillStyle='#06060c';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  
  const loc=locations.find(l=>l.id===myChar.location_id);
  if(loc){
    ctx.fillStyle='#1a1030';
    ctx.font='14px sans-serif';
    ctx.fillText(loc.name,10,20);
  }
  
  // grid
  ctx.strokeStyle='#0e0e18';
  ctx.lineWidth=1;
  for(let x=0;x<canvas.width;x+=20){
    ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();
  }
  for(let y=0;y<canvas.height;y+=20){
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();
  }
  
  // other players
  Object.values(otherPlayers).forEach(p=>{
    if(p.location_id===myChar.location_id && p.x_pos!=null && p.y_pos!=null){
      ctx.fillStyle='#50a0ff';
      ctx.fillRect(p.x_pos*20,p.y_pos*20,18,18);
      ctx.fillStyle='#c8b89a';
      ctx.font='10px sans-serif';
      ctx.fillText(p.character_name,p.x_pos*20,p.y_pos*20-4);
    }
  });
  
  // my character
  if(myChar.x_pos!=null && myChar.y_pos!=null){
    ctx.fillStyle='#ff6060';
    ctx.fillRect(myChar.x_pos*20,myChar.y_pos*20,20,20);
    ctx.fillStyle='#fff';
    ctx.font='10px sans-serif';
    ctx.fillText(myChar.character_name,myChar.x_pos*20,myChar.y_pos*20-4);
  }
}

async function travelTo(locId){
  const r=await fetch(API+'/character/move',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({location_id:locId})
  });
  if(r.ok){
    const d=await r.json();
    myChar.location_id=d.location_id;
    myChar.x_pos=d.x_pos;
    myChar.y_pos=d.y_pos;
    updateUI();
    addChatSys('Переход в '+locations.find(l=>l.id===locId).name);
  }
}
