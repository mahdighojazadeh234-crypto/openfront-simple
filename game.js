(() => {
  const socket = io();

  // DOM
  const lobbyEl = document.getElementById('lobby');
  const gameEl = document.getElementById('game');
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const msgEl = document.getElementById('msg');

  let state = null;
  let myId = null;
  let selectedTile = null; // {x,y}
  let buildMode = null; // 'city' | 'factory' | null
  let camera = { x: 0, y: 0, zoom: 1 };
  let isDragging = false;
  let lastTouch = null;
  let tileSize = 16;

  // ========== LOBBY ==========
  document.getElementById('btnCreate').onclick = () => {
    const name = document.getElementById('playerName').value.trim() || 'میزبان';
    const mapKey = document.getElementById('mapSelect').value;
    const botCount = parseInt(document.getElementById('botCount').value) || 8;
    socket.emit('createRoom', { name, mapKey, botCount });
  };

  document.getElementById('btnJoin').onclick = () => {
    const name = document.getElementById('playerName').value.trim() || 'بازیکن';
    const code = document.getElementById('roomCode').value.trim().toUpperCase();
    if (!code) return showMsg('کد اتاق را وارد کنید');
    socket.emit('joinRoom', { code, name });
  };

  socket.on('roomCreated', ({ code, state: s }) => {
    myId = socket.id;
    state = s;
    showGame();
    showMsg(`اتاق ساخته شد: ${code} — دکمه شروع را بزنید`);
    // Add start button temporarily
    addStartButton();
  });

  socket.on('joined', ({ code, state: s }) => {
    myId = socket.id;
    state = s;
    showGame();
    showMsg(`وارد اتاق ${code} شدید. منتظر شروع بازی...`);
  });

  socket.on('gameStarted', (s) => {
    state = s;
    removeStartButton();
    showMsg('بازی شروع شد!');
    fitCamera();
  });

  socket.on('stateUpdate', (s) => {
    state = s;
    updateHUD();
    draw();
  });

  socket.on('error', ({ msg }) => showMsg(msg));

  function addStartButton() {
    if (document.getElementById('btnStart')) return;
    const btn = document.createElement('button');
    btn.id = 'btnStart';
    btn.textContent = 'شروع بازی';
    btn.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);z-index:30;padding:14px 28px;font-size:1.1rem;';
    btn.onclick = () => {
      socket.emit('startGame');
      btn.remove();
    };
    gameEl.appendChild(btn);
  }

  function removeStartButton() {
    const btn = document.getElementById('btnStart');
    if (btn) btn.remove();
  }

  function showGame() {
    lobbyEl.style.display = 'none';
    gameEl.style.display = 'flex';
    resizeCanvas();
    fitCamera();
    updateHUD();
    draw();
  }

  // ========== CANVAS & DRAW ==========
  function resizeCanvas() {
    const wrap = document.getElementById('canvasWrap');
    canvas.width = wrap.clientWidth * devicePixelRatio;
    canvas.height = wrap.clientHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function fitCamera() {
    if (!state) return;
    const wrap = document.getElementById('canvasWrap');
    const pad = 20;
    const scaleX = (wrap.clientWidth - pad * 2) / (state.width * tileSize);
    const scaleY = (wrap.clientHeight - pad * 2) / (state.height * tileSize);
    camera.zoom = Math.min(scaleX, scaleY, 2.5);
    camera.x = (wrap.clientWidth - state.width * tileSize * camera.zoom) / 2;
    camera.y = (wrap.clientHeight - state.height * tileSize * camera.zoom) / 2;
  }

  function worldToScreen(x, y) {
    return {
      x: camera.x + x * tileSize * camera.zoom,
      y: camera.y + y * tileSize * camera.zoom
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: Math.floor((sx - camera.x) / (tileSize * camera.zoom)),
      y: Math.floor((sy - camera.y) / (tileSize * camera.zoom))
    };
  }

  function getPlayerColor(id) {
    if (!state) return '#666';
    const p = state.players.find(p => p.id === id);
    return p ? p.color : '#666';
  }

  function draw() {
    if (!state) return;
    const wrap = document.getElementById('canvasWrap');
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Background water
    ctx.fillStyle = '#0c4a6e';
    ctx.fillRect(0, 0, w, h);

    const ts = tileSize * camera.zoom;

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const idx = y * state.width + x;
        const land = state.landMap[y][x];
        if (land !== 1) continue;

        const tile = state.tiles[idx];
        const pos = worldToScreen(x, y);

        // Land base
        if (tile.o) {
          ctx.fillStyle = getPlayerColor(tile.o);
        } else {
          ctx.fillStyle = '#4a7c59'; // neutral land
        }
        ctx.fillRect(pos.x, pos.y, ts + 0.5, ts + 0.5);

        // Building indicator
        if (tile.b === 'city') {
          ctx.fillStyle = '#fbbf24';
          ctx.beginPath();
          ctx.arc(pos.x + ts/2, pos.y + ts/2, ts * 0.25, 0, Math.PI * 2);
          ctx.fill();
        } else if (tile.b === 'factory') {
          ctx.fillStyle = '#94a3b8';
          ctx.fillRect(pos.x + ts*0.25, pos.y + ts*0.25, ts*0.5, ts*0.5);
        }

        // Troops number (only if zoomed enough and has troops)
        if (camera.zoom > 0.9 && tile.t > 0) {
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.max(9, ts * 0.4)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tile.t > 999 ? Math.floor(tile.t/1000)+'k' : tile.t, pos.x + ts/2, pos.y + ts/2);
        }
      }
    }

    // Selected tile highlight
    if (selectedTile) {
      const pos = worldToScreen(selectedTile.x, selectedTile.y);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(pos.x + 1, pos.y + 1, ts - 2, ts - 2);
    }

    // Grid lines when zoomed
    if (camera.zoom > 1.2) {
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= state.width; x++) {
        const p = worldToScreen(x, 0);
        ctx.beginPath();
        ctx.moveTo(p.x, camera.y);
        ctx.lineTo(p.x, camera.y + state.height * ts);
        ctx.stroke();
      }
      for (let y = 0; y <= state.height; y++) {
        const p = worldToScreen(0, y);
        ctx.beginPath();
        ctx.moveTo(camera.x, p.y);
        ctx.lineTo(camera.x + state.width * ts, p.y);
        ctx.stroke();
      }
    }
  }

  // ========== INPUT ==========
  const wrap = document.getElementById('canvasWrap');

  function handleTap(sx, sy) {
    if (!state || !state.started) return;
    const {x, y} = screenToWorld(sx, sy);
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
    if (state.landMap[y][x] !== 1) return;

    const idx = y * state.width + x;
    const tile = state.tiles[idx];

    if (buildMode) {
      if (tile.o === myId) {
        socket.emit('build', { x, y, type: buildMode });
        buildMode = null;
        updateBuildButtons();
      } else {
        showMsg('فقط روی سرزمین خودتان بسازید');
      }
      return;
    }

    // Select or attack
    if (!selectedTile) {
      if (tile.o === myId) {
        selectedTile = {x, y};
        draw();
      }
      return;
    }

    // Already selected
    if (selectedTile.x === x && selectedTile.y === y) {
      selectedTile = null;
      draw();
      return;
    }

    // Try attack / move
    const fromIdx = selectedTile.y * state.width + selectedTile.x;
    const fromTile = state.tiles[fromIdx];
    if (fromTile.o !== myId) {
      selectedTile = null;
      draw();
      return;
    }

    const ratio = parseInt(document.getElementById('attackRatio').value) / 100;
    socket.emit('attack', {
      fromX: selectedTile.x,
      fromY: selectedTile.y,
      toX: x,
      toY: y,
      ratio
    });
    selectedTile = null;
  }

  // Mouse
  wrap.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      isDragging = false;
      lastTouch = {x: e.clientX, y: e.clientY, time: Date.now()};
    }
  });
  wrap.addEventListener('mousemove', (e) => {
    if (lastTouch && e.buttons === 1) {
      const dx = e.clientX - lastTouch.x;
      const dy = e.clientY - lastTouch.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        isDragging = true;
        camera.x += dx;
        camera.y += dy;
        lastTouch = {x: e.clientX, y: e.clientY};
        draw();
      }
    }
  });
  wrap.addEventListener('mouseup', (e) => {
    if (!isDragging && lastTouch && Date.now() - lastTouch.time < 300) {
      const rect = canvas.getBoundingClientRect();
      handleTap(e.clientX - rect.left, e.clientY - rect.top);
    }
    lastTouch = null;
    isDragging = false;
  });

  // Touch
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      lastTouch = {x: t.clientX, y: t.clientY, time: Date.now()};
      isDragging = false;
    }
  }, {passive: true});

  wrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && lastTouch) {
      const t = e.touches[0];
      const dx = t.clientX - lastTouch.x;
      const dy = t.clientY - lastTouch.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        isDragging = true;
        camera.x += dx;
        camera.y += dy;
        lastTouch = {x: t.clientX, y: t.clientY};
        draw();
      }
    }
  }, {passive: true});

  wrap.addEventListener('touchend', (e) => {
    if (!isDragging && lastTouch && Date.now() - lastTouch.time < 300) {
      const rect = canvas.getBoundingClientRect();
      const t = e.changedTouches[0];
      handleTap(t.clientX - rect.left, t.clientY - rect.top);
    }
    lastTouch = null;
    isDragging = false;
  });

  // Pinch zoom (simple)
  let lastPinchDist = null;
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist = Math.sqrt(dx*dx + dy*dy);
    }
  }, {passive: true});
  wrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && lastPinchDist) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const scale = dist / lastPinchDist;
      camera.zoom = Math.max(0.4, Math.min(3, camera.zoom * scale));
      lastPinchDist = dist;
      draw();
    }
  }, {passive: true});
  wrap.addEventListener('touchend', () => { lastPinchDist = null; });

  // Wheel zoom
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    camera.zoom = Math.max(0.4, Math.min(3, camera.zoom * factor));
    draw();
  }, {passive: false});

  // ========== BUILD & HUD ==========
  document.getElementById('btnCity').onclick = () => {
    buildMode = buildMode === 'city' ? null : 'city';
    selectedTile = null;
    updateBuildButtons();
  };
  document.getElementById('btnFactory').onclick = () => {
    buildMode = buildMode === 'factory' ? null : 'factory';
    selectedTile = null;
    updateBuildButtons();
  };
  document.getElementById('btnCancelBuild').onclick = () => {
    buildMode = null;
    updateBuildButtons();
  };

  document.getElementById('attackRatio').oninput = (e) => {
    document.getElementById('ratioVal').textContent = e.target.value + '٪';
  };

  function updateBuildButtons() {
    document.getElementById('btnCity').classList.toggle('active', buildMode === 'city');
    document.getElementById('btnFactory').classList.toggle('active', buildMode === 'factory');
    document.getElementById('btnCancelBuild').style.display = buildMode ? 'inline-block' : 'none';
  }

  function updateHUD() {
    if (!state || !myId) return;
    const me = state.players.find(p => p.id === myId);
    if (me) {
      document.getElementById('gold').textContent = me.gold;
      document.getElementById('myTroops').textContent = me.troops;
      document.getElementById('myTiles').textContent = me.tiles;
    }

    const list = document.getElementById('playersList');
    list.innerHTML = state.players
      .filter(p => p.alive || p.tiles > 0)
      .sort((a, b) => b.tiles - a.tiles)
      .slice(0, 12)
      .map(p => `
        <div class="player-row">
          <div class="color-dot" style="background:${p.color}"></div>
          <span>${p.name}${p.isBot ? ' (ربات)' : ''} — ${p.tiles}</span>
        </div>
      `).join('');
  }

  function showMsg(text) {
    msgEl.textContent = text;
    msgEl.classList.add('show');
    setTimeout(() => msgEl.classList.remove('show'), 2500);
  }

  // Initial
  resizeCanvas();
})();