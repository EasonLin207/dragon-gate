// 1. 初始化 Supabase
const SB_URL = 'https://fglioudvkmuompkgbdvf.supabase.co';
const SB_KEY = 'sb_publishable_qFHBu0Uu6tdZ2QyXtGQBUA_epYW516t';
const _supabase = supabase.createClient(SB_URL, SB_KEY);

let currentRoomId = '';
let isHost = false;
let myPlayerId = null;
let currentBetAmount = 0;
let initPotValue = 100;
let playersList = [];
let currentTurnIndex = 0;
let lastKnownTurnPlayerId = null; // 紀錄最後知道的回合玩家ID，避免重複刷新UI

// 介面切換
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(`screen-${id}`).classList.remove('hidden');
}

// 主持人：建立房間
async function createRoom() {
    currentRoomId = document.getElementById('new-room-id').value.trim();
    initPotValue = parseInt(document.getElementById('init-pot').value) || 100;

    if (!currentRoomId) return alert("請輸入房間號");

    // 初始底池設為 0，每當有新玩家加入時自動疊加 initPotValue
    const { error } = await _supabase.from('rooms').insert([{ id: currentRoomId, pot: 0 }]);
    if (error) {
        if (error.message.includes('duplicate key')) {
            alert("房間已存在！已為您恢復主持人身分並載入原有底池。");
        } else {
            alert("錯誤：" + error.message);
            return;
        }
    }

    isHost = true;
    document.getElementById('host-controls').classList.remove('hidden');
    startSync();
}

// 玩家：加入房間
async function joinRoom() {
    currentRoomId = document.getElementById('join-room-id').value.trim();
    const name = document.getElementById('player-name').value.trim();
    if (!currentRoomId || !name) return alert("請填寫房間號與暱稱");

    // 檢查是否有同名玩家
    const { data: existingPlayers } = await _supabase
        .from('players')
        .select('*')
        .eq('room_id', currentRoomId)
        .eq('name', name);

    if (existingPlayers && existingPlayers.length > 0) {
        // 接管既有身分
        myPlayerId = existingPlayers[0].id;
        alert(`歡迎回來，${name}！已恢復您的籌碼狀態。`);
    } else {
        // 建立新玩家
        const { data, error } = await _supabase.from('players')
            .insert([{ room_id: currentRoomId, name: name, chips: 0 }])
            .select()
            .single();

        if (error) {
            return alert("加入失敗，請確認房間號是否存在");
        }
        myPlayerId = data.id;
    }

    isHost = false;
    document.getElementById('host-controls').classList.add('hidden');
    startSync();
}

// 啟動即時同步
function startSync() {
    showScreen('game');

    // 監聽底池更新
    _supabase.channel('room_sync')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${currentRoomId}` }, payload => {
            document.getElementById('display-pot').innerText = payload.new.pot;
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'players', filter: `room_id=eq.${currentRoomId}` }, async payload => {
            if (isHost) {
                // 每當有新玩家加入，由主持人自動幫房間底池增加設定好的底注！
                let { data: room } = await _supabase.from('rooms').select('pot').eq('id', currentRoomId).single();
                if (room) {
                    await _supabase.from('rooms').update({ pot: room.pot + initPotValue }).eq('id', currentRoomId);
                }
            }
            refreshRank();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'players', filter: `room_id=eq.${currentRoomId}` }, payload => {
            refreshRank();
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players', filter: `room_id=eq.${currentRoomId}` }, payload => {
            refreshRank();
        })
        .subscribe();

    // 監聽房間事件 (輪值與下注)
    _supabase.channel('room_events')
        .on('broadcast', { event: 'turn_update' }, payload => {
            const currentTurnPlayer = payload.payload.player || payload.payload;
            const turnInitPot = payload.payload.initPot || 100;

            document.getElementById('turn-player-name').innerText = currentTurnPlayer.name;

            // 處理非對稱 UI 顯示 (只在回合真正切換時更新UI)
            if (lastKnownTurnPlayerId !== currentTurnPlayer.id) {
                lastKnownTurnPlayerId = currentTurnPlayer.id; // 更新為新玩家

                if (!isHost) {
                    if (currentTurnPlayer.id === myPlayerId) {
                        document.getElementById('player-bet-panel').classList.remove('hidden');
                        document.getElementById('player-bet-val').value = turnInitPot; // Reset to initPot

                        // 動態更新快捷按鈕
                        const btn1 = document.getElementById('btn-add-1');
                        const btn2 = document.getElementById('btn-add-2');
                        if (btn1) {
                            btn1.innerText = `+${turnInitPot}`;
                            btn1.onclick = () => addBet(turnInitPot);
                        }
                        if (btn2) {
                            btn2.innerText = `+${turnInitPot * 2}`;
                            btn2.onclick = () => addBet(turnInitPot * 2);
                        }

                        document.getElementById('game-msg').innerText = "【換你了】請決定下注金額！";
                    } else {
                        document.getElementById('player-bet-panel').classList.add('hidden');
                        document.getElementById('game-msg').innerText = `等待 ${currentTurnPlayer.name} 下注中...`;
                    }
                } else {
                    document.getElementById('host-view-bet').innerText = "等待下注中...";
                    document.getElementById('game-msg').innerText = `目前輪到 ${currentTurnPlayer.name}，等待下注中...`;
                    // 鎖定判定按鈕直到收到注金
                    toggleHostButtons(true);
                }
            }
        })
        .on('broadcast', { event: 'bet_placed' }, payload => {
            if (isHost) {
                currentBetAmount = payload.payload.amount;
                document.getElementById('host-view-bet').innerText = currentBetAmount;
                document.getElementById('game-msg').innerText = `玩家已下注 ${currentBetAmount}，請進行判定！`;
                // 解鎖判定按鈕
                toggleHostButtons(false);
            } else {
                document.getElementById('game-msg').innerText = "玩家已下注，等待主持人判定結果...";
            }
        })
        .subscribe();

    refreshRank();
    setInterval(refreshRank, 3000);
}

//鎖定或解開主持人的判定按鈕
function toggleHostButtons(disabled) {
    const btns = document.querySelectorAll('#host-controls .btn-group button');
    btns.forEach(btn => {
        // 放棄按鈕永遠不鎖，以便卡住時可以直接跳過
        if (!btn.classList.contains('neutral')) {
            btn.disabled = disabled;
            btn.style.opacity = disabled ? '0.5' : '1';
            btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
        }
    });
}

// ====== 玩家專屬下注邏輯 ======
function addBet(val) {
    const input = document.getElementById('player-bet-val');
    const currentPot = parseInt(document.getElementById('display-pot').innerText) || 0;
    let current = parseInt(input.value) || 0;

    if (val === 'all') {
        input.value = currentPot;
    } else {
        input.value = current + val;
    }
}

function confirmBet() {
    const input = document.getElementById('player-bet-val');
    const currentPot = parseInt(document.getElementById('display-pot').innerText) || 0;
    let bet = parseInt(input.value) || 0;

    if (bet <= 0) return alert("下注金額必須大於0");
    if (bet > currentPot) return alert("下注金額不能大於當前底池！");
    // 允許負籌碼，所以不再阻擋 bet > myPlayer.chips

    document.getElementById('player-bet-panel').classList.add('hidden');
    document.getElementById('game-msg').innerText = "已下注，等待主持人判定結果...";

    _supabase.channel('room_events').send({
        type: 'broadcast',
        event: 'bet_placed',
        payload: { amount: bet, playerId: myPlayerId }
    });
}

// ====== 主持人判定邏輯 ======
async function updateGame(result) {
    if (playersList.length === 0) return alert("目前沒有玩家");

    // 取底池金額以便驗證
    let { data: room } = await _supabase.from('rooms').select('pot').eq('id', currentRoomId).single();
    if (!room) return;

    const currentPlayer = playersList[currentTurnIndex];
    let newPot = room.pot;
    let newChips = currentPlayer.chips;
    let msg = "";

    // 如果是放棄，不檢查 betAmount，直接 fold
    if (result !== 'fold') {
        if (currentBetAmount <= 0) return alert("玩家尚未下注或下注金額無效！");

        const bet = currentBetAmount;
        if (result === 'win') {
            newPot -= bet;
            newChips += bet;
            msg = `✅ ${currentPlayer.name} 獲勝！贏得 ${bet} (結算後底池: ${newPot})`;
        } else if (result === 'lose') {
            newPot += bet;
            newChips -= bet;
            msg = `❌ ${currentPlayer.name} 沒中！賠了 ${bet}`;
        } else if (result === 'hit2') {
            newPot += (bet * 2);
            newChips -= (bet * 2);
            msg = `💥 ${currentPlayer.name} 撞柱！賠兩倍 ${bet * 2}`;
        } else if (result === 'hit3') {
            newPot += (bet * 3);
            newChips -= (bet * 3);
            msg = `💥 ${currentPlayer.name} 撞柱！賠三倍 ${bet * 3}`;
        }
    } else {
        msg = `⏩ ${currentPlayer.name} 放棄！換下一把。`;
    }

    document.getElementById('game-msg').innerText = msg;

    // 處理資料庫更新
    if (result !== 'fold') {
        const updateRoom = _supabase.from('rooms').update({ pot: newPot }).eq('id', currentRoomId);
        const updatePlayer = _supabase.from('players').update({ chips: newChips }).eq('id', currentPlayer.id);
        await Promise.all([updateRoom, updatePlayer]);
        currentPlayer.chips = newChips; // 本地更新防閃爍

        // --- 自動補池機制 ---
        if (newPot <= 0) {
            console.log("底池歸零！觸發自動補池！", currentRoomId, initPotValue);
            document.getElementById('game-msg').innerText += `\n⚠️ 底池歸零，向全體扣除 ${initPotValue} 進行補池！`;
            const { error: rpcError } = await _supabase.rpc('auto_refill_pot', {
                target_room_id: currentRoomId,
                refill_amount: initPotValue
            });
            if (rpcError) console.error("Auto Refill RPC failed: ", rpcError);
        }
    }

    // 重置注金並換下一位
    currentBetAmount = 0;
    if (isHost) { document.getElementById('host-view-bet').innerText = "等待下注中..."; }
    nextTurn();
}

function nextTurn() {
    if (playersList.length === 0) return;
    currentTurnIndex = (currentTurnIndex + 1) % playersList.length;
    broadcastTurn();
}

function broadcastTurn() {
    if (playersList.length === 0) return;
    const currentTurnPlayer = playersList[currentTurnIndex];

    // 主持人自己也要更新顯示
    document.getElementById('turn-player-name').innerText = currentTurnPlayer.name;

    _supabase.channel('room_events').send({
        type: 'broadcast',
        event: 'turn_update',
        payload: { player: currentTurnPlayer, initPot: initPotValue }
    });
}

// 主持人踢人
async function kickPlayer(id) {
    if (!confirm('確定要踢出這位玩家嗎？')) return;
    await _supabase.from('players').delete().eq('id', id);
    // 因為有監聽 DELETE，refreshRank 會自己捕捉到
}

async function refreshRank() {
    const { data, error } = await _supabase.from('players')
        .select('*')
        .eq('room_id', currentRoomId)
        .order('id', { ascending: true }); // 先依據 id 取出保持輪替穩定順序

    if (error) console.error("refreshRank error:", error);

    if (data) {
        playersList = data; // 保存固定順序的玩家名單以便輪值使用

        // 針對畫面顯示的排行榜，額外複製一份依照 chips 遞減排序
        const sortedForDisplay = [...data].sort((a, b) => b.chips - a.chips);

        document.getElementById('rank-list').innerHTML = sortedForDisplay.map(p => {
            const kickBtn = isHost ? `<button class="kick-btn" onclick="kickPlayer('${p.id}')">❌踢出</button>` : '';
            return `<li><span>${p.name}</span> <span>💰${p.chips} ${kickBtn}</span></li>`;
        }).join('');

        // 主持人每次重整都會推一次廣播，確保持晚加入的玩家能收到目前狀態
        if (isHost && playersList.length > 0) {
            broadcastTurn();
        }

        // 防呆機制：如果當前輪值超過人數（例如踢人後），重置
        if (currentTurnIndex >= playersList.length && playersList.length > 0) {
            currentTurnIndex = 0;
            if (isHost) broadcastTurn();
        }
    }
}