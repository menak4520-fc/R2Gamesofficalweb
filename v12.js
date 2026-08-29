/* R2 GAMES V12 - production bridge
   The existing design remains intact. This layer fixes transport, server-backed
   friends/inbox/daily/drafts/rewards, and the real online room lifecycle. */
(function(){
  'use strict';
  const ID=/^\d{16}$/;
  const GAMES=['auction','five','deal','blind','guess','hidden'];
  let socket=null, connected=false, player=null, room=null, reconnecting=false;
  let claimSeq=0;
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function status(t){const e=$('room-status');if(e)e.textContent=t;}
  function load(){try{return JSON.parse(localStorage.getItem('r2_v11_player')||localStorage.getItem('r2_v10_player')||'null')}catch{return null}}
  player=load();
  if(!player||!ID.test(player.id)) player={id:Array.from({length:16},()=>Math.floor(Math.random()*10)).join(''),name:'لاعب R2'};
  function save(){localStorage.setItem('r2_v11_player',JSON.stringify(player));localStorage.setItem('r2_v10_player',JSON.stringify(player));}
  save();
  function apply(p){if(!p)return;player={...player,...p};save();if(window.R2?.state){Object.assign(window.R2.state,{xb:p.xb??window.R2.state.xb,points:p.points??window.R2.state.points,coins:p.coins??window.R2.state.coins,xp:p.xp??window.R2.state.xp,level:p.level??window.R2.state.level,freeDrafts:p.freeDrafts??window.R2.state.freeDrafts});try{window.R2.render()}catch{}}}
  function setRoom(r){room=r||null;if(r)localStorage.setItem('r2_v12_room',JSON.stringify(r));else localStorage.removeItem('r2_v12_room');}
  try{const r=JSON.parse(localStorage.getItem('r2_v12_room')||'null');if(r?.code)room=r}catch{}

  function playButton(show){
    let b=$('r2-server-play-now');
    if(!b&&show){b=document.createElement('button');b.id='r2-server-play-now';b.className='btn';b.type='button';b.style.cssText='width:100%;margin-top:10px;font-size:1.05rem';b.textContent='🎮 العب الآن';b.onclick=()=>playNow();const s=$('room-status');if(s?.parentNode)s.parentNode.insertBefore(b,s.nextSibling)}
    if(b){b.style.display=show?'block':'none';const me=room?.players?.find(x=>x.id===player.id);b.disabled=!!me?.ready;b.textContent=b.disabled?'⏳ جاهز — في انتظار اللاعب الآخر':'🎮 العب الآن'}
  }
  function roomConnected(){return !!(socket?.connected)}

  function connect(){
    if(!window.io)return setTimeout(connect,200);
    if(socket)return;
    // Bonto/proxies are much more reliable when polling is first, then upgraded.
    socket=window.io({transports:['polling','websocket'],upgrade:true,reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:500,reconnectionDelayMax:3000,timeout:7000,forceNew:true});
    socket.on('connect',()=>{connected=true;reconnecting=false;status('🟢 السيرفر متصل');socket.emit('identify',{playerId:player.id,name:player.name},r=>{if(r?.player)apply(r.player);socket.emit('welcome:claim',{playerId:player.id},w=>{if(w?.player)apply(w.player);});loadDaily();loadInbox();});if(room?.code)socket.emit('room:state-request',{code:room.code},r=>{if(r?.ok){setRoom(r.room);if(r.room.playerCount===2)playButton(true)}})});
    socket.on('connect_error',()=>{connected=false;reconnecting=true;status('🟠 تعذر الاتصال — إعادة المحاولة تلقائيًا...')});
    socket.io.on('reconnect_attempt',()=>status('🔄 إعادة الاتصال بالسيرفر...'));
    socket.on('disconnect',()=>{connected=false;reconnecting=true;status('🔄 انقطع الاتصال — جاري إعادة الاتصال...')});
    socket.on('player:data',apply);socket.on('game:reward',x=>{if(x?.playerId===player.id)apply(x.player)});
    socket.on('room:connected',r=>{setRoom(r);if(r.playerCount===2){playButton(true);status('🟢 اللاعبان متصلان 2/2 — اضغط «العب الآن»')}else{playButton(false);status('⏳ في انتظار اللاعب الثاني...')}});
    socket.on('room:players',r=>{setRoom(r);if(r.playerCount===2)playButton(true)});
    socket.on('room:ready-state',r=>{setRoom(r);playButton(true);status('🎮 الجاهزون: '+(r.readyCount||0)+'/2')});
    socket.on('room:player-left',x=>{playButton(false);status('🔴 خرج اللاعب الآخر — المتصلون '+(x?.players||1)+'/2')});
    socket.on('game:start',startGame);
    socket.on('game:sync',x=>{if(typeof window.R2OnlineSync==='function')window.R2OnlineSync(x);});
    socket.on('game:event',x=>{if(typeof window.R2OnlineEvent==='function')window.R2OnlineEvent(x);});
    socket.on('guess:state',x=>renderGuess(x));socket.on('guess:result',x=>guessResult(x));socket.on('guess:finished',x=>guessFinished(x));
    socket.on('friends:request',()=>{loadInbox();alert('📩 وصلك طلب صداقة جديد')});
    socket.on('friends:accepted',()=>{loadFriends()});
    socket.on('quick:invite',x=>{if(confirm('⚡ '+(x.from?.name||'صديق')+' دعاك لمباراة. قبول؟'))socket.emit('quick:accept',{fromId:x.from.id,playerId:player.id,name:player.name,game:x.game},r=>{if(r?.ok){setRoom(r.room);playButton(true)}})});
    socket.on('quick:matched',x=>{setRoom(x.room);playButton(true);status('⚡ تم العثور على الخصم — لازم الاثنين يضغطوا «العب الآن»')});
    socket.on('tournament:match-ready',x=>{setRoom(x.room);status('🏆 مواجهة البطولة جاهزة — المباراة تبدأ تلقائيًا عند اتصال الطرفين')});
    socket.on('tournament:update',()=>{});
  }

  function startGame(x){setRoom(x.room);playButton(false);const game=x.game;if(game==='guess'){window.__r2OnlineGuess=true;show('guess-game');socket.emit('guess:start',{code:x.room.code},r=>{if(r?.guess)renderGuess(r.guess)});return}const fn={auction:'startAuctionSetup',five:'startFiveGame',deal:'startDealGame',blind:'startBlindGame',hidden:'startHiddenPlayerGame'}[game];if(fn&&typeof window[fn]==='function'){try{window[fn]()}catch(e){console.error(e)}}}
  function show(id){if(typeof window.showSection==='function')window.showSection(id)}
  function playNow(){if(!socket?.connected)return alert('السيرفر غير متصل — انتظر الاتصال.');if(!room?.code)return alert('لا توجد غرفة.');socket.emit('room:play-now',{code:room.code},r=>{if(!r?.ok)return alert(r?.error||'تعذر الجاهزية');setRoom(r.room);playButton(true);status(r.room.readyCount<2?'⏳ أنت جاهز 1/2 — في انتظار اللاعب الآخر':'🚀 2/2 — بدء اللعبة...')})}
  function createRoom(){if(!socket?.connected)return alert('جارٍ الاتصال بالسيرفر، حاول بعد لحظة.');const game=$('room-game-select')?.value||'auction';const password=$('room-password-enabled')?.checked?$('room-password')?.value||'':'';socket.emit('room:create',{game,password,playerId:player.id,name:player.name},r=>{if(!r?.ok)return alert(r?.error||'تعذر إنشاء الغرفة');setRoom(r);if($('generated-code'))$('generated-code').textContent=r.code;playButton(false);status('🟢 الغرفة جاهزة — الكود '+r.code+' — 8 حروف/أرقام')})}
  function joinRoom(){const code=String($('join-code-input')?.value||'').trim().toUpperCase();const password=$('join-password-input')?.value||'';if(!/^[A-Z0-9]{8}$/.test(code))return alert('كود الغرفة يجب أن يكون 8 حروف أو أرقام.');if(!socket?.connected)return alert('جارٍ الاتصال بالسيرفر، انتظر لحظة.');socket.emit('room:join',{code,password,playerId:player.id,name:player.name},r=>{if(!r?.ok)return alert(r?.error||'تعذر الاتصال بالغرفة');setRoom(r);if($('room-game-select'))$('room-game-select').value=r.game;if(r.playerCount===2){playButton(true);status('🟢 تم الاتصال 2/2 — اضغط «العب الآن»')}})}
  function quickMatch(){if(!socket?.connected)return alert('جارٍ الاتصال بالسيرفر، انتظر لحظة.');const game=$('room-game-select')?.value||'auction';socket.emit('quick:join',{game,playerId:player.id,name:player.name},r=>{if(!r?.ok)return alert(r?.error||'تعذر QUICK MATCH');if(r.matched){setRoom(r.room);playButton(true)}else status('⚡ QUICK MATCH: جاري البحث عن لاعب مناسب...')})}

  function loadFriends(){if(!socket?.connected)return;socket.emit('friends:list',{playerId:player.id},r=>{if(!r?.ok)return;const e=$('friends-list');if(!e)return;e.innerHTML=(r.friends||[]).map(f=>'<div class="r2-card">👤 '+esc(f.name)+' — '+esc(f.id)+' <span style="color:var(--accent-green)">'+(f.online?'متصل':'غير متصل')+'</span></div>').join('')||'لا يوجد أصدقاء بعد.'})}
  function addFriend(){const id=String($('friend-id-input')?.value||'').trim();if(!ID.test(id))return alert('اكتب ID صحيح من 16 رقم.');if(!socket?.connected)return alert('السيرفر غير متصل.');socket.emit('friends:add',{playerId:player.id,friendId:id},r=>{if(!r?.ok)return alert(r?.error||'تعذر إرسال الطلب');$('friend-id-input').value='';alert('📩 تم إرسال طلب الصداقة');loadFriends()})}
  function renderInbox(d){const e=$('inbox-messages');if(!e)return;let html=(d.incomingRequests||[]).map(f=>'<div class="r2-card">📩 طلب صداقة من <b>'+esc(f.name)+'</b><br><small>ID: '+esc(f.id)+'</small><div style="margin-top:8px"><button class="btn" onclick="R2V12.acceptFriend(\''+f.id+'\')">قبول</button> <button class="btn btn-danger" onclick="R2V12.rejectFriend(\''+f.id+'\')">رفض</button></div></div>').join('');if(d.welcomeAvailable)html+='<div class="r2-card">🎁 مكافأة الترحيب متاحة: 3000 POINTS + 1 DRAFT<button class="btn" style="width:100%;margin-top:8px" onclick="R2V12.claimWelcome()">استلام</button></div>';e.innerHTML=html||'<div class="r2-card">📭 لا توجد رسائل جديدة.</div>'}
  function loadInbox(){if(!socket?.connected)return;socket.emit('inbox:get',{playerId:player.id},r=>{if(r?.ok)renderInbox(r)})}
  function acceptFriend(id){socket.emit('friends:accept',{playerId:player.id,friendId:id},r=>{if(!r?.ok)return alert(r.error);loadInbox();loadFriends()})}
  function rejectFriend(id){socket.emit('friends:reject',{playerId:player.id,friendId:id},r=>{if(r?.ok)loadInbox()})}
  function claimWelcome(){socket.emit('welcome:claim',{playerId:player.id},r=>{if(!r?.ok)return alert(r.error);apply(r.player);alert('🎁 استلمت 3000 POINTS + 1 FREE DRAFT');loadInbox()})}

  function loadDaily(){if(!socket?.connected)return;socket.emit('daily:get',{playerId:player.id},r=>{if(r?.ok)renderDaily(r.daily)})}
  function renderDaily(d){const e=$('r2-tasks');if(!e)return;e.innerHTML=(d.tasks||[]).map(t=>'<div class="r2-player">'+(t.claimed?'✅':'⏳')+' '+esc(t.name)+': '+t.progress+'/'+t.target+(t.progress>=t.target&&!t.claimed?'<button class="btn" style="margin-right:8px" onclick="R2V12.claimDaily(\''+t.id+'\')">استلام</button>':'')+'</div>').join('')+'<div style="margin-top:10px;font-weight:bold">'+(d.tasks.every(t=>t.claimed)?'✅ أكملت 5/5 — انتظر لغد.':'🎯 5 مهام يومية')+'</div>'}
  function claimDaily(id){socket.emit('daily:claim',{playerId:player.id,taskId:id},r=>{if(!r?.ok)return alert(r.error);apply(r.player);renderDaily(r.daily)})}

  function openFreeDraft(){socket.emit('draft:open-free',{playerId:player.id},r=>{if(!r?.ok)return alert(r.error);apply(r.player);const a=$('r2-action');if(a)a.innerHTML='<div class="r2-card"><h3>🎁 FREE DRAFT</h3><p>اختر اللاعب الذي تريده. اللاعب الفائز أُضيف لحسابك، ولا يوجد تكرار.</p>'+r.choices.map((c,i)=>'<button class="btn" style="margin:4px" onclick="R2V12.pickDraft('+i+')">'+esc(c.name)+' — '+c.pos+' — '+c.rating+'</button>').join('')+'</div>';window.__draftChoices=r.choices;})}
  function pickDraft(i){const c=window.__draftChoices?.[i];if(!c)return;const a=$('r2-action');if(a)a.innerHTML='<div class="r2-card">🎉 تم اختيار <b>'+esc(c.name)+'</b> — '+c.pos+' — '+c.rating+' OVR</div>';if(window.R2?.state){window.R2.state.team=window.R2.state.team||[];if(!window.R2.state.team.some(p=>p.name===c.name))window.R2.state.team.push(c);window.R2.render()}}

  function renderGuess(d){window.__r2GuessState=d;const r=$('guess-round'),t=$('guess-turn'),c=$('guess-clubs'),a=$('guess-answer'),o=$('guess-result');if(r)r.textContent='الجولة '+d.round+' من 5';const mine=d.turnPlayerId===player.id;if(t)t.innerHTML=mine?'🎯 دورك — اكتب اسم اللاعب واضغط تخمين ⚽':'⏳ دور اللاعب الآخر';if(c)c.innerHTML='🏟️ الأندية: <b>'+((d.clubs||[]).map(esc).join(' ← '))+'</b>';if(a){a.disabled=!mine;a.placeholder=mine?'اكتب اسم اللاعب':'انتظر دورك'}if(o)o.textContent='📊 '+scoreText(d.score)}
  function scoreText(s){return (room?.players||[]).map(p=>esc(p.name)+': '+(s?.[p.id]||0)).join(' — ')}
  function submitGuess(){const a=$('guess-answer');const v=String(a?.value||'').trim();if(!v)return alert('اكتب اسم اللاعب أولًا.');if(!window.__r2GuessState||window.__r2GuessState.turnPlayerId!==player.id)return alert('ليس دورك الآن.');socket.emit('guess:answer',{code:room.code,answer:v},r=>{if(!r?.ok)alert(r.error||'تعذر إرسال الإجابة')})}
  function guessResult(d){const e=$('guess-result');if(e)e.innerHTML=(d.correct?'✅ صحيحة':'❌ خاطئة')+' — اللاعب: <b>'+esc(d.answer)+'</b><br>📊 '+scoreText(d.score)}
  function guessFinished(d){const ps=room?.players||[],a=d.score?.[ps[0]?.id]||0,b=d.score?.[ps[1]?.id]||0;const e=$('guess-result');if(e)e.innerHTML='🏁 انتهت 5 جولات<br><strong style="font-size:1.5rem">'+a+' - '+b+'</strong><br>'+(a===b?'🤝 تعادل':a>b?'🏆 '+esc(ps[0]?.name):'🏆 '+esc(ps[1]?.name));}

  async function loadNews(){const el=$('r2-news-list');if(!el)return;el.innerHTML='<div class="r2-card">⏳ جاري جلب الأخبار من السيرفر...</div>';try{const r=await fetch('/api/news?ts='+Date.now(),{cache:'no-store',headers:{Accept:'application/json'}});const text=await r.text();let d;try{d=JSON.parse(text)}catch(e){throw new Error('السيرفر أرسل استجابة غير صالحة للأخبار')};if(!r.ok||!d.ok)throw new Error(d.error||'تعذر جلب الأخبار');if(!d.ready){el.innerHTML='<div class="r2-card">⏳ السيرفر يحدث الأخبار الآن...<br><small>سيتم التحديث تلقائيًا.</small></div>';setTimeout(loadNews,2500);return}el.innerHTML=(d.items||[]).map(x=>'<div class="r2-card"><b>'+esc(x.title)+'</b><br><small>'+esc(x.source||'')+' — '+esc(x.publishedAt||'')+'</small><br><a href="'+esc(x.link||'#')+'" target="_blank" rel="noopener">اقرأ الخبر ←</a></div>').join('')||'<div class="r2-card">لا توجد أخبار الآن.</div>'}catch(e){el.innerHTML='<div class="r2-card">🔴 '+esc(e.message||e)+'<br><button class="btn" onclick="loadR2News()">إعادة المحاولة</button></div>'}}
  window.loadR2News=loadNews;

  function syncAll(){loadFriends();loadInbox();loadDaily();}
  function init(){connect();setTimeout(()=>{if(socket?.connected)syncAll()},1500);const oldOpen=window.openModal; if(oldOpen&&!oldOpen.__r2v12){window.openModal=function(id){oldOpen(id);if(id==='friendsModal')loadFriends();if(id==='inboxModal')loadInbox();if(id==='challengesModal')loadDaily();};window.openModal.__r2v12=true} }
  window.R2V12={player,createRoom,joinRoom,quickMatch,playNow,sendFriendRequest:addFriend,acceptFriend,rejectFriend,claimWelcome,loadInbox,loadFriends,loadDaily,claimDaily,openFreeDraft,pickDraft,submitGuess};
  window.generateNewRoomCode=createRoom;window.connectRoom=joinRoom;window.quickMatch=quickMatch;window.sendFriendRequest=addFriend;
  window.submitGuess=submitGuess;
  // Replace the local completion reward with a server claim, preserving UI/game flow.
  if(window.R2){const old=window.R2.completeGame;window.R2.completeGame=function(){const game=room?.game||'guess';if(socket?.connected&&!room?.code){const key='single-'+game+'-'+Date.now()+'-'+(++claimSeq);socket.emit('game:single-complete',{playerId:player.id,game,claimKey:key},r=>{if(r?.ok){apply(r.player);if($('match-stats-content'))$('match-stats-content').innerHTML='<div class="r2-card">📊 النتيجة المعتمدة: '+r.score.home+' - '+r.score.away+'</div>';}});loadDaily();return}return old?.apply(this,arguments)}}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
