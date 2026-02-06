const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = 5000; // 5 giây
const RETRY_DELAY = 5000;
const MAX_HISTORY = 50;

// Lưu trữ dữ liệu
let latestResult100 = {
    "Phien": 0, "Xuc_xac_1": 0, "Xuc_xac_2": 0, "Xuc_xac_3": 0,
    "Tong": 0, "Ket_qua": "Chưa có", "id": "kapub",
    "Du_doan_tiep": "Đang phân tích...", "Do_tin_cay": 0,
    "Du_doan_dung": null
};

let latestResult101 = {
    "Phien": 0, "Xuc_xac_1": 0, "Xuc_xac_2": 0, "Xuc_xac_3": 0,
    "Tong": 0, "Ket_qua": "Chưa có", "id": "kapub",
    "Du_doan_tiep": "Đang phân tích...", "Do_tin_cay": 0,
    "Du_doan_dung": null
};

let history100 = [];
let history101 = [];

let lastSid100 = null;
let lastSid101 = null;
let sidForTx = null;

// Cấu trúc lịch sử dự đoán chi tiết
let predictionHistory = {
    taiXiu: [],      // Lịch sử dự đoán Tài Xỉu thường
    taiXiuMD5: []    // Lịch sử dự đoán Tài Xỉu MD5
};

// ===================== CORE FUNCTIONS =====================
function getTaiXiu(d1, d2, d3) {
    const total = d1 + d2 + d3;
    return total <= 10 ? "Xỉu" : "Tài";
}

// Cập nhật kết quả và lịch sử
function updateResult(store, history, result, gameType) {
    // Kiểm tra nếu phiên đã tồn tại trong lịch sử
    const existingIndex = history.findIndex(h => h.Phien === result.Phien);
    
    if (existingIndex !== -1) {
        // Cập nhật kết quả hiện có
        const existingResult = history[existingIndex];
        
        // Cập nhật dự đoán đúng/sai cho phiên trước
        if (existingResult.Du_doan_tiep) {
            existingResult.Du_doan_dung = existingResult.Du_doan_tiep === result.Ket_qua;
            
            // Cập nhật vào lịch sử dự đoán
            updatePredictionHistory(gameType, {
                phien: existingResult.Phien,
                du_doan: existingResult.Du_doan_tiep,
                ket_qua_thuc_te: result.Ket_qua,
                do_tin_cay: existingResult.Do_tin_cay,
                dung: existingResult.Du_doan_dung,
                thoi_gian: new Date().toISOString()
            });
        }
        
        // Cập nhật dữ liệu mới
        Object.assign(existingResult, result);
    } else {
        // Thêm mới vào lịch sử
        history.unshift(result);
        
        // Giới hạn lịch sử
        if (history.length > MAX_HISTORY) {
            history.pop();
        }
    }
    
    // Cập nhật store
    Object.assign(store, result);
}

// Cập nhật lịch sử dự đoán
function updatePredictionHistory(gameType, predictionData) {
    const history = gameType === 'taiXiu' ? predictionHistory.taiXiu : predictionHistory.taiXiuMD5;
    
    history.unshift(predictionData);
    
    if (history.length > MAX_HISTORY) {
        history.pop();
    }
}

// ===================== 15 THUẬT TOÁN DETERMINISTIC =====================
function algo1WeightedRecent(history) {
    if (!history.length) return "Tài";
    let t = 0, x = 0;
    for (let i = 0; i < history.length; i++) {
        const weight = (i + 1) / history.length;
        if (history[i] === "Tài") t += weight;
        else x += weight;
    }
    return t >= x ? "Tài" : "Xỉu";
}

function algo2ExpDecay(history, decay = 0.6) {
    if (!history.length) return "Tài";
    let t = 0, x = 0, w = 1;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] === "Tài") t += w;
        else x += w;
        w *= decay;
    }
    return t > x ? "Tài" : "Xỉu";
}

function algo3LongChainReverse(history, k = 3) {
    if (!history.length) return "Tài";
    const last = history[history.length - 1];
    let chain = 1;
    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i] === last) chain++;
        else break;
    }
    if (chain >= k && last === "Tài") return "Xỉu";
    if (chain >= k) return "Tài";
    return last;
}

function algo4WindowMajority(history, window = 5) {
    const win = history.slice(-window);
    if (!win.length) return "Tài";
    const taiCount = win.filter(v => v === "Tài").length;
    return taiCount >= win.length / 2 ? "Tài" : "Xỉu";
}

function algo5Alternation(history) {
    if (history.length < 4) return "Tài";
    let flips = 0;
    for (let i = 1; i <= 3; i++) {
        if (history[history.length - i] !== history[history.length - i - 1]) {
            flips++;
        }
    }
    if (flips >= 3 && history[history.length - 1] === "Tài") return "Xỉu";
    if (flips >= 3) return "Tài";
    return history[history.length - 1];
}

function algo6PatternRepeat(history) {
    const L = history.length;
    if (L < 4) return "Tài";
    
    for (let length = 2; length <= Math.min(5, Math.floor(L / 2)); length++) {
        const a = history.slice(-length).join('');
        const b = history.slice(-2 * length, -length).join('');
        if (a === b) return history[-length];
    }
    
    return algo4WindowMajority(history, 4);
}

function algo7Mirror(history) {
    if (history.length < 8) return history.length ? history[history.length - 1] : "Tài";
    
    const last4 = history.slice(-4);
    const prev4 = history.slice(-8, -4);
    
    if (JSON.stringify(last4) === JSON.stringify(prev4) && history[history.length - 1] === "Tài") {
        return "Xỉu";
    }
    
    return history[history.length - 1];
}

function algo8Entropy(history) {
    if (!history.length) return "Tài";
    const t = history.filter(v => v === "Tài").length;
    const x = history.length - t;
    const diff = Math.abs(t - x);
    
    if (diff <= history.length / 5) {
        return history[history.length - 1] === "Tài" ? "Xỉu" : "Tài";
    }
    
    return t > x ? "Xỉu" : "Tài";
}

function algo9Volatility(history) {
    if (history.length < 4) return "Tài";
    let flips = 0;
    for (let i = 1; i < history.length; i++) {
        if (history[i] !== history[i - 1]) flips++;
    }
    const flipRatio = flips / history.length;
    
    if (flipRatio > 0.55 && history[history.length - 1] === "Tài") {
        return "Xỉu";
    }
    
    return history[history.length - 1];
}

function algo10Momentum(history) {
    if (history.length < 2) return "Tài";
    let score = 0;
    for (let i = 1; i < history.length; i++) {
        score += history[i] === history[i - 1] ? 1 : -1;
    }
    
    if (score > 0) return history[history.length - 1];
    return history[history.length - 1] === "Tài" ? "Xỉu" : "Tài";
}

function algo11ParityIndex(history) {
    if (!history.length) return "Tài";
    let score = 0;
    for (let i = 0; i < history.length; i++) {
        if ((i % 2 === 0 && history[i] === "Tài") || (i % 2 === 1 && history[i] === "Xỉu")) {
            score++;
        } else {
            score--;
        }
    }
    
    const nextEven = history.length % 2 === 0;
    if ((score >= 0 && nextEven) || (score < 0 && !nextEven)) {
        return "Tài";
    }
    return "Xỉu";
}

function algo12Autocorr(history) {
    if (history.length < 4) return "Tài";
    let sT = 0, sX = 0;
    const maxLag = Math.min(5, history.length - 1);
    
    for (let lag = 1; lag <= maxLag; lag++) {
        if (lag * 2 <= history.length) {
            const a = history.slice(-lag);
            const b = history.slice(-2 * lag, -lag);
            
            if (JSON.stringify(a) === JSON.stringify(b)) {
                if (a[0] === "Tài") sT++;
                else sX++;
            }
        }
    }
    
    if (sT > sX) return "Tài";
    if (sX > sT) return "Xỉu";
    return history[history.length - 1];
}

function algo13SubwindowMajority(history) {
    if (history.length < 3) return "Tài";
    const votes = [];
    const maxWindow = Math.min(6, history.length);
    
    for (let w = 3; w <= maxWindow; w++) {
        const win = history.slice(-w);
        const taiCount = win.filter(v => v === "Tài").length;
        votes.push(taiCount >= win.length / 2 ? "Tài" : "Xỉu");
    }
    
    const taiVotes = votes.filter(v => v === "Tài").length;
    return taiVotes >= votes.length / 2 ? "Tài" : "Xỉu";
}

function algo14RunParity(history) {
    if (!history.length) return "Tài";
    let cur = history[0];
    let length = 1;
    let maxRun = 1;
    
    for (let i = 1; i < history.length; i++) {
        if (history[i] === cur) {
            length++;
        } else {
            maxRun = Math.max(maxRun, length);
            cur = history[i];
            length = 1;
        }
    }
    maxRun = Math.max(maxRun, length);
    
    if (maxRun >= 4 && history[history.length - 1] === "Tài") {
        return "Xỉu";
    }
    
    return history[history.length - 1];
}

function algo15FreqRatio(history) {
    if (!history.length) return "Tài";
    const ratio = history.filter(v => v === "Tài").length / history.length;
    
    if (ratio > 0.62) return "Xỉu";
    if (ratio < 0.38) return "Tài";
    return history[history.length - 1];
}

// Danh sách thuật toán
const algos = [
    algo1WeightedRecent,
    algo2ExpDecay,
    algo3LongChainReverse,
    algo4WindowMajority,
    algo5Alternation,
    algo6PatternRepeat,
    algo7Mirror,
    algo8Entropy,
    algo9Volatility,
    algo10Momentum,
    algo11ParityIndex,
    algo12Autocorr,
    algo13SubwindowMajority,
    algo14RunParity,
    algo15FreqRatio
];

// Hàm hybrid kết hợp 15 thuật toán
function hybrid15(history) {
    if (!history.length) {
        return {
            prediction: "Tài",
            confidence: 70,
            votes: []
        };
    }
    
    let scoreT = 0;
    let scoreX = 0;
    const votes = [];
    
    algos.forEach(fn => {
        const v = fn(history);
        votes.push(v);
        if (v === "Tài") scoreT++;
        else scoreX++;
    });
    
    const pred = scoreT >= scoreX ? "Tài" : "Xỉu";
    const conf = Math.round((Math.max(scoreT, scoreX) / (scoreT + scoreX)) * 100);
    
    return {
        prediction: pred,
        confidence: conf,
        votes: votes
    };
}

// ===================== API POLLER =====================
async function pollAPI(gid, resultStore, history, isMD5) {
    const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=${gid}`;
    
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Node.js-Agent' },
            timeout: 10000
        });
        
        const data = response.data;
        
        if (data.status === 'OK' && Array.isArray(data.data)) {
            // Xử lý MD5 (gid=vgmn_100)
            if (isMD5) {
                for (const game of data.data) {
                    if (game.cmd === 2006) {
                        const { sid, d1, d2, d3 } = game;
                        
                        if (sid && sid !== lastSid101 && d1 !== undefined && d2 !== undefined && d3 !== undefined) {
                            lastSid101 = sid;
                            const total = d1 + d2 + d3;
                            const ket_qua = getTaiXiu(d1, d2, d3);
                            
                            const result = {
                                Phien: sid,
                                Xuc_xac_1: d1,
                                Xuc_xac_2: d2,
                                Xuc_xac_3: d3,
                                Tong: total,
                                Ket_qua: ket_qua,
                                id: "kapub",
                                Du_doan_tiep: "Đang phân tích...",
                                Do_tin_cay: 0,
                                Du_doan_dung: null,
                                Thoi_gian: new Date().toISOString()
                            };
                            
                            updateResult(resultStore, history, result, 'taiXiuMD5');
                            
                            // Tính dự đoán cho phiên tiếp theo
                            const histResults = history
                                .filter(h => h.Ket_qua === "Tài" || h.Ket_qua === "Xỉu")
                                .map(h => h.Ket_qua)
                                .reverse();
                            
                            const pred = hybrid15(histResults);
                            resultStore.Du_doan_tiep = pred.prediction;
                            resultStore.Do_tin_cay = pred.confidence;
                            
                            console.log(`[MD5] Phiên ${sid} - Tổng: ${total}, KQ: ${ket_qua} | Dự đoán kế: ${pred.prediction} (${pred.confidence}%)`);
                        }
                    }
                }
            } 
            // Xử lý TX thường (gid=vgmn_101)
            else {
                // Tìm sid từ cmd 1008
                for (const game of data.data) {
                    if (game.cmd === 1008) {
                        sidForTx = game.sid;
                        break;
                    }
                }
                
                // Xử lý kết quả từ cmd 1003
                for (const game of data.data) {
                    if (game.cmd === 1003) {
                        const { d1, d2, d3 } = game;
                        const sid = sidForTx;
                        
                        if (sid && sid !== lastSid100 && d1 !== undefined && d2 !== undefined && d3 !== undefined) {
                            lastSid100 = sid;
                            const total = d1 + d2 + d3;
                            const ket_qua = getTaiXiu(d1, d2, d3);
                            
                            const result = {
                                Phien: sid,
                                Xuc_xac_1: d1,
                                Xuc_xac_2: d2,
                                Xuc_xac_3: d3,
                                Tong: total,
                                Ket_qua: ket_qua,
                                id: "kapub",
                                Du_doan_tiep: "Đang phân tích...",
                                Do_tin_cay: 0,
                                Du_doan_dung: null,
                                Thoi_gian: new Date().toISOString()
                            };
                            
                            updateResult(resultStore, history, result, 'taiXiu');
                            
                            console.log(`[TX] Phiên ${sid} - Tổng: ${total}, KQ: ${ket_qua}`);
                            sidForTx = null;
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Lỗi khi lấy dữ liệu API ${gid}:`, error.message);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
}

// Khởi động polling
async function startPolling() {
    // Poll TX thường
    setInterval(async () => {
        await pollAPI("vgmn_101", latestResult100, history100, false);
    }, POLL_INTERVAL);
    
    // Poll TX MD5
    setInterval(async () => {
        await pollAPI("vgmn_100", latestResult101, history101, true);
    }, POLL_INTERVAL);
}

// ===================== EXPRESS API =====================
app.get('/api/taixiu', (req, res) => {
    res.json(latestResult100);
});

app.get('/api/taixiumd5', (req, res) => {
    res.json(latestResult101);
});

app.get('/api/history', (req, res) => {
    res.json({
        taixiu: history100,
        taixiumd5: history101
    });
});

app.get('/api/prediction-history', (req, res) => {
    const { type = 'all' } = req.query;
    
    if (type === 'taiXiu') {
        res.json(predictionHistory.taiXiu);
    } else if (type === 'taiXiuMD5') {
        res.json(predictionHistory.taiXiuMD5);
    } else {
        res.json(predictionHistory);
    }
});

app.get('/api/predict', (req, res) => {
    const history = history101
        .filter(h => h.Ket_qua === "Tài" || h.Ket_qua === "Xỉu")
        .map(h => h.Ket_qua)
        .reverse();
    
    const result = hybrid15(history);
    
    res.json({
        next_prediction: result.prediction,
        confidence: result.confidence,
        votes: result.votes,
        history_len: history.length,
        algorithm_count: algos.length,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/stats', (req, res) => {
    const calculateStats = (history) => {
        if (history.length === 0) return { total: 0, correct: 0, accuracy: 0 };
        
        const predictions = history.filter(h => h.Du_doan_dung !== null);
        const correct = predictions.filter(h => h.Du_doan_dung === true).length;
        
        return {
            total: predictions.length,
            correct: correct,
            accuracy: predictions.length > 0 ? (correct / predictions.length * 100).toFixed(2) : 0
        };
    };
    
    res.json({
        taiXiu: {
            current: latestResult100,
            stats: calculateStats(history100),
            recent: history100.slice(0, 5)
        },
        taiXiuMD5: {
            current: latestResult101,
            stats: calculateStats(history101),
            recent: history101.slice(0, 5)
        },
        predictionStats: {
            taiXiu: {
                total: predictionHistory.taiXiu.length,
                correct: predictionHistory.taiXiu.filter(p => p.dung).length,
                accuracy: predictionHistory.taiXiu.length > 0 
                    ? (predictionHistory.taiXiu.filter(p => p.dung).length / predictionHistory.taiXiu.length * 100).toFixed(2)
                    : 0
            },
            taiXiuMD5: {
                total: predictionHistory.taiXiuMD5.length,
                correct: predictionHistory.taiXiuMD5.filter(p => p.dung).length,
                accuracy: predictionHistory.taiXiuMD5.length > 0
                    ? (predictionHistory.taiXiuMD5.filter(p => p.dung).length / predictionHistory.taiXiuMD5.length * 100).toFixed(2)
                    : 0
            }
        }
    });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>🎲 API Tài Xỉu AI V2.0</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                h1 { color: #333; }
                .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
                code { background: #eee; padding: 2px 5px; }
            </style>
        </head>
        <body>
            <h1>✅ API Tài Xỉu AI V2.0</h1>
            <p>Hệ thống dự đoán Tài Xỉu với lịch sử dự đoán chi tiết</p>
            
            <h2>📊 Endpoints:</h2>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/api/taixiu</code>
                <p>Kết quả Tài Xỉu thường mới nhất</p>
            </div>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/api/taixiumd5</code>
                <p>Kết quả Tài Xỉu MD5 mới nhất</p>
            </div>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/api/history</code>
                <p>Lịch sử kết quả</p>
            </div>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/api/prediction-history</code>
                <p>Lịch sử dự đoán chi tiết (thêm ?type=taiXiu hoặc ?type=taiXiuMD5)</p>
            </div>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/api/predict</code>
                <p>Dự đoán phiên tiếp theo</p>
            </div>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/api/stats</code>
                <p>Thống kê độ chính xác dự đoán</p>
            </div>
            
            <h2>📈 Thông tin hệ thống:</h2>
            <ul>
                <li>Phiên bản: 2.0.0</li>
                <li>Thuật toán: 15 thuật toán hybrid</li>
                <li>Lịch sử lưu trữ: ${MAX_HISTORY} phiên</li>
                <li>Độ chính xác: Theo dõi real-time</li>
                <li>Thời gian cập nhật: ${POLL_INTERVAL/1000} giây</li>
            </ul>
        </body>
        </html>
    `);
});

// ===================== KHỞI ĐỘNG SERVER =====================
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy trên port ${PORT}`);
    console.log(`📡 Khởi động hệ thống AI Tài Xỉu V2.0 với lịch sử dự đoán...`);
    startPolling();
});
