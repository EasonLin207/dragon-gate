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
let lastKnownTurnPlayerId = null;
let initChipsValue = 1000;
window.onload = () => {
    renderHistoryRooms();
}

function renderHistoryRooms() {
    let history = JSON.parse(localStorage.getItem('myHostRooms')) || [];
    const container = document.getElementById('history-rooms-container');

    if (history.length > 0) {
        container.classList.remove('hidden');
        container.innerHTML = '<h4 style="color:#f1c40f;">📂 我的已建房間</h4>' + history.map((r, index) => {
            const rId = typeof r === 'string' ? r : r.id;
            const rPot = typeof r === 'string' ? 100 : r.initPot;
            const rChips = typeof r === 'string' ? 1000 : r.initChips;

            return `
                <div class="history-item">
                    <span>房間：<b>${rId}</b></span>
                    <div>
                        <button class="success" onclick="quickStartRoom('${rId}', ${rPot}, ${rChips})">加入</button>
                        <button class="delete-room-btn" onclick="deleteHistoryRoom(${index}, '${rId}')">刪除</button>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        container.classList.add('hidden');
    }
}

async function deleteHistoryRoom(index, roomId) {
    if (!confirm(`確定要徹底刪除房間 [${roomId}] 的所有資料嗎？`)) return;

    // 刪除資料庫該房間
    if (roomId) {
        // 必須先砍掉該房間底下的所有玩家(若資料庫無設定 CASCADE)
        await _supabase.from('players').delete().eq('room_id', roomId);
        // 再砍掉房間本身
        await _supabase.from('rooms').delete().eq('id', roomId);
    }
    // 刪除本地紀錄
    let history = JSON.parse(localStorage.getItem('myHostRooms')) || [];
    history.splice(index, 1);
    localStorage.setItem('myHostRooms', JSON.stringify(history));
    renderHistoryRooms();
}

function quickStartRoom(id, pot, chips) {
    document.getElementById('new-room-id').value = id;
    document.getElementById('init-pot').value = pot;
    document.getElementById('init-chips').value = chips;
    createRoom();
}

// 介面切換
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(`screen-${id}`).classList.remove('hidden');
}

// 主持人：建立房間
async function createRoom() {
    currentRoomId = document.getElementById('new-room-id').value.trim();
    if (!currentRoomId) return alert("請輸入房間號");

    // 【防呆】從歷史紀錄抓庫存設定，避免被輸入框覆蓋掉原本的初始底池設定
    let history = JSON.parse(localStorage.getItem('myHostRooms')) || [];
    let existingConf = history.find(r => (typeof r === 'string' ? r : r.id) === currentRoomId);

    if (existingConf && typeof existingConf === 'object') {
        initPotValue = existingConf.initPot || 100;
        initChipsValue = existingConf.initChips !== undefined ? existingConf.initChips : 0;
        // 把正確數值回填到畫面上
        document.getElementById('init-pot').value = initPotValue;
        document.getElementById('init-chips').value = initChipsValue;
    } else {
        initPotValue = parseInt(document.getElementById('init-pot').value) || 100;
        initChipsValue = parseInt(document.getElementById('init-chips').value) || 0;
    }

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

    // 儲存至歷史紀錄 (無重複、且最新的在最前面)
    history = JSON.parse(localStorage.getItem('myHostRooms')) || [];
    history = history.filter(r => (typeof r === 'string' ? r : r.id) !== currentRoomId);
    history.unshift({ id: currentRoomId, initPot: initPotValue, initChips: initChipsValue });
    localStorage.setItem('myHostRooms', JSON.stringify(history));
    renderHistoryRooms();

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

    // 剛開局或剛加入時，先主動向資料庫要一次最新的底池金額，確保兩邊畫面同步
    _supabase.from('rooms').select('pot').eq('id', currentRoomId).single().then(({ data }) => {
        if (data) document.getElementById('display-pot').innerText = data.pot;
    });

    if (isHost) {
        document.getElementById('display-init-pot').innerText = initPotValue;
    }

    // 監聽底池更新
    _supabase.channel('room_sync')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${currentRoomId}` }, payload => {
            document.getElementById('display-pot').innerText = payload.new.pot;
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'players', filter: `room_id=eq.${currentRoomId}` }, async payload => {
            if (isHost) {
                // 主動拿取當前最新底池
                const { data: room } = await _supabase.from('rooms').select('pot').eq('id', currentRoomId).single();
                const currentPot = room ? room.pot : 0;

                // 將這名新玩家的底注疊加上去 (不再用 count * initPot 直接覆蓋全部，避免吃掉輸家的底池)
                await _supabase.from('rooms').update({ pot: currentPot + initPotValue }).eq('id', currentRoomId);

                // 給予新玩家初始籌碼，並自動扣除他入場的底注！
                const newPlayerId = payload.new.id;
                await _supabase.from('players').update({ chips: initChipsValue - initPotValue }).eq('id', newPlayerId);
            }
            refreshRank();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'players', filter: `room_id=eq.${currentRoomId}` }, payload => {
            refreshRank();
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players', filter: `room_id=eq.${currentRoomId}` }, async payload => {
            // 玩家退出不退回底注，因為底注已經是場上的「死錢」
            refreshRank();
        })
        .subscribe();

    // 監聽房間事件 (輪值與下注)
    _supabase.channel('room_events')
        .on('broadcast', { event: 'turn_update' }, payload => {
            // 嚴格隔離其他房間的事件
            if (payload.payload.roomId !== currentRoomId) return;

            const currentTurnPlayer = payload.payload.player || payload.payload;
            const turnInitPot = payload.payload.initPot || 100;

            initPotValue = turnInitPot;
            document.getElementById('display-init-pot').innerText = initPotValue;

            document.getElementById('turn-player-name').innerText = currentTurnPlayer.name;

            // 處理非對稱 UI 顯示 (只在回合真正切換時更新UI)
            if (lastKnownTurnPlayerId !== currentTurnPlayer.id) {
                lastKnownTurnPlayerId = currentTurnPlayer.id; // 更新為新玩家

                if (!isHost) {
                    if (currentTurnPlayer.id === myPlayerId) {
                        // 輪到自己時，隱藏上一局的個人結算結果
                        document.getElementById('personal-result').classList.add('hidden');

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
            // 嚴格隔離其他房間的事件
            if (payload.payload.roomId !== currentRoomId) return;

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
        .on('broadcast', { event: 'show_settlement' }, payload => {
            if (payload.payload.roomId !== currentRoomId) return;
            renderSettlement(payload.payload.results);
        })
        .on('broadcast', { event: 'turn_result' }, payload => {
            if (payload.payload.roomId !== currentRoomId) return;
            const res = payload.payload;

            // 如果是本人的結果，顯示專屬橫幅
            if (res.playerId === myPlayerId) {
                const prDiv = document.getElementById('personal-result');
                prDiv.innerHTML = `${res.actionText}！你獲得了 <span class="${res.colorClass}">${res.prefix}${res.netChange}</span>`;
                prDiv.classList.remove('hidden');
            }
        })
        .subscribe();

    refreshRank();
    setInterval(refreshRank, 3000);
}

//鎖定或解開主持人的判定按鈕
function toggleHostButtons(disabled) {
    // 只鎖定第一組勝負判定的按鈕，不要鎖定到下方補注或結算按鈕
    const btns = document.querySelectorAll('#host-controls .btn-group:first-of-type button');
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
        payload: { amount: bet, playerId: myPlayerId, roomId: currentRoomId }
    });
}

// ====== 主持人判定邏輯 ======
async function updateGame(result) {
    if (playersList.length === 0) return alert("目前沒有玩家");

    // 【重要防呆】在進入任何非同步(await)之前，先檢查本地注金狀態並鎖定按鈕
    // 這樣可以防止主持人手速太快「連點兩下」導致第二次執行時 bet 變成 0 而報錯
    if (result !== 'fold' && currentBetAmount <= 0) {
        return alert("玩家尚未下注或下注金額無效！");
    }

    // 立即鎖定判定按鈕，直到下個玩家下注才解開
    toggleHostButtons(true);

    // 取底池金額以便驗證
    let { data: room } = await _supabase.from('rooms').select('pot').eq('id', currentRoomId).single();
    if (!room) return;

    const currentPlayer = playersList[currentTurnIndex];
    let newPot = room.pot;
    let newChips = currentPlayer.chips;
    let msg = "";
    let actionText = "";
    let netChange = 0;
    let colorClass = "neutral";
    let prefix = "";

    // 如果是放棄，直接 fold
    if (result !== 'fold') {
        const bet = currentBetAmount;
        if (result === 'win') {
            newPot -= bet;
            newChips += bet;
            netChange = bet;
            actionText = "✅ 獲勝";
            colorClass = "win-text";
            prefix = "+";
            msg = `✅ ${currentPlayer.name} 獲勝！贏得 ${bet} (結算後底池: ${newPot})`;
        } else if (result === 'lose') {
            newPot += bet;
            newChips -= bet;
            netChange = bet;
            actionText = "❌ 沒中";
            colorClass = "lose-text";
            prefix = "-";
            msg = `❌ ${currentPlayer.name} 沒中！賠了 ${bet}`;
        } else if (result === 'hit2') {
            newPot += (bet * 2);
            newChips -= (bet * 2);
            netChange = bet * 2;
            actionText = "💥 撞柱(2倍)";
            colorClass = "lose-text";
            prefix = "-";
            msg = `💥 ${currentPlayer.name} 撞柱！賠兩倍 ${bet * 2}`;
        } else if (result === 'hit3') {
            newPot += (bet * 3);
            newChips -= (bet * 3);
            netChange = bet * 3;
            actionText = "💥 撞柱(3倍)";
            colorClass = "lose-text";
            prefix = "-";
            msg = `💥 ${currentPlayer.name} 撞柱！賠三倍 ${bet * 3}`;
        }
    } else {
        actionText = "⏩ 放棄";
        msg = `⏩ ${currentPlayer.name} 放棄！換下一把。`;
    }

    document.getElementById('game-msg').innerText = msg;

    // 推播結果給所有人 (包含紀錄器與個人橫幅)
    const logPayload = {
        roomId: currentRoomId,
        playerId: currentPlayer.id,
        name: currentPlayer.name,
        actionText: actionText,
        netChange: netChange,
        colorClass: colorClass,
        prefix: prefix
    };

    _supabase.channel('room_events').send({
        type: 'broadcast',
        event: 'turn_result',
        payload: logPayload
    });

    // 處理資料庫更新
    if (result !== 'fold') {
        const updateRoom = _supabase.from('rooms').update({ pot: newPot }).eq('id', currentRoomId);
        const updatePlayer = _supabase.from('players').update({ chips: newChips }).eq('id', currentPlayer.id);
        await Promise.all([updateRoom, updatePlayer]);
        currentPlayer.chips = newChips; // 本地更新防閃爍

        // --- 底池過低警告 (改為純手動) ---
        if (newPot < playersList.length * initPotValue) {
            console.log("底池低於安全值！請主持人手動補注", currentRoomId, initPotValue);
            document.getElementById('game-msg').innerText += `\n⚠️ 底池過低或歸零，請主持人視情況點擊【全體補注】！`;
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
        payload: { player: currentTurnPlayer, initPot: initPotValue, roomId: currentRoomId }
    });
}

// 主持人踢人
async function kickPlayer(id) {
    if (!confirm('確定要踢出這位玩家嗎？')) return;
    await _supabase.from('players').delete().eq('id', id);
    // 因為有監聽 DELETE，refreshRank 會自己捕捉到
}

async function refreshRank() {
    // 每次更新排名時，順便重新向資料庫抓取最新的底池金額，確保斷線/重連/漏掉推播的玩家能被強制同步
    const { data: roomData } = await _supabase.from('rooms').select('pot').eq('id', currentRoomId).single();
    if (roomData) {
        document.getElementById('display-pot').innerText = roomData.pot;
    }

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

        // 單人防呆防線
        if (playersList.length <= 1) {
            document.getElementById('room-warning').classList.remove('hidden');
            document.getElementById('player-bet-panel').classList.add('hidden');
            if (isHost) toggleHostButtons(true);
            return; // 終止遊戲邏輯廣播與執行
        } else {
            document.getElementById('room-warning').classList.add('hidden');
        }

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

// 主持人：一鍵歸零
async function resetPot() {
    if (!confirm('確定要將底池歸零嗎？')) return;
    await _supabase.from('rooms').update({ pot: 0 }).eq('id', currentRoomId);
}

// 主持人：全體強制手動補注
async function manualRefill() {
    if (!confirm(`確定要向全體玩家再次扣除 ${initPotValue} 作為預防性補注嗎？`)) return;

    try {
        const { data: room } = await _supabase.from('rooms').select('pot').eq('id', currentRoomId).single();
        if (!room) return alert("找不到房間底池");

        const totalRefill = playersList.length * initPotValue;
        const newRoomPot = room.pot + totalRefill;

        // 1. 更新房間底池
        const updateRoomPot = _supabase.from('rooms').update({ pot: newRoomPot }).eq('id', currentRoomId);

        // 2. 更新所有玩家籌碼
        const updateAllPlayers = playersList.map(p => {
            return _supabase.from('players').update({ chips: p.chips - initPotValue }).eq('id', p.id);
        });

        await Promise.all([updateRoomPot, ...updateAllPlayers]);
        alert("已成功對全體強制補注！");
    } catch (err) {
        console.error("Manual Refill Error: ", err);
        alert("補注失敗：" + err.message);
    }
}

// ====== 結算遊戲邏輯 ======
function endGame() {
    if (!confirm('確定要結束這場遊戲並進入結算畫面嗎？所有玩家將會看到最終結果。')) return;

    // 計算每位玩家的輸贏 (目前籌碼 - 初始發放的籌碼)
    const results = playersList.map(p => {
        const net = p.chips - initChipsValue;
        return { name: p.name, net: net };
    });

    // 依照輸贏金額排序 (贏最多的在最上面)
    results.sort((a, b) => b.net - a.net);

    // 主持人自己也要先切換到結算畫面
    renderSettlement(results);

    // 廣播給全房間的玩家顯示結算畫面
    _supabase.channel('room_events').send({
        type: 'broadcast',
        event: 'show_settlement',
        payload: { roomId: currentRoomId, results: results }
    });
}

function renderSettlement(results) {
    showScreen('settlement');
    const ul = document.getElementById('settlement-list');

    ul.innerHTML = results.map(r => {
        let colorClass = 'neutral';
        let prefix = '';
        if (r.net > 0) {
            colorClass = 'win-text';
            prefix = '+';
        } else if (r.net < 0) {
            colorClass = 'lose-text';
        }

        return `<li style="font-size: 1.2rem;">
            <span>${r.name}</span> 
            <span class="${colorClass}">${prefix}${r.net}</span>
        </li>`;
    }).join('');
}

function backToLobby() {
    // 刷新整個畫面回到初始狀態
    window.location.reload();
}