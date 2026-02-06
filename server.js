const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 5000;

// API URL cũ theo yêu cầu
const API_URL_TX = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_101';
const API_URL_MD5 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_100';

const LEARNING_FILE = 'learning_data.json';
const HISTORY_FILE = 'prediction_history.json';

const MAX_HISTORY = 100;
const AUTO_SAVE_INTERVAL = 30000;
let lastProcessedPhien = { hu: null, md5: null };

// ==================== DATA STORAGE ====================
let predictionHistory = {
  hu: [],
  md5: []
};

let learningData = {
  hu: {
    predictions: [],
    patternStats: {},
    totalPredictions: 0,
    correctPredictions: 0,
    patternWeights: {},
    lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    adaptiveThresholds: {},
    recentAccuracy: []
  },
  md5: {
    predictions: [],
    patternStats: {},
    totalPredictions: 0,
    correctPredictions: 0,
    patternWeights: {},
    lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    adaptiveThresholds: {},
    recentAccuracy: []
  }
};

const DEFAULT_PATTERN_WEIGHTS = {
  'cau_bet': 1.0,
  'cau_dao_11': 1.0,
  'cau_22': 1.0,
  'cau_33': 1.0,
  'cau_121': 1.0,
  'cau_123': 1.0,
  'cau_321': 1.0,
  'cau_nhay_coc': 1.0,
  'cau_nhip_nghieng': 1.0,
  'cau_3van1': 1.0,
  'cau_be_cau': 1.0,
  'cau_chu_ky': 1.0,
  'distribution': 1.0,
  'dice_pattern': 1.0,
  'sum_trend': 1.0,
  'edge_cases': 1.0,
  'momentum': 1.0,
  'cau_tu_nhien': 1.0
};

// ==================== HELPER FUNCTIONS ====================
function loadLearningData() {
  try {
    if (fs.existsSync(LEARNING_FILE)) {
      const data = fs.readFileSync(LEARNING_FILE, 'utf8');
      const parsed = JSON.parse(data);
      learningData = { ...learningData, ...parsed };
      console.log('Learning data loaded successfully');
    }
  } catch (error) {
    console.error('Error loading learning data:', error.message);
  }
}

function saveLearningData() {
  try {
    fs.writeFileSync(LEARNING_FILE, JSON.stringify(learningData, null, 2));
  } catch (error) {
    console.error('Error saving learning data:', error.message);
  }
}

function loadPredictionHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(data);
      predictionHistory = parsed.history || { hu: [], md5: [] };
      lastProcessedPhien = parsed.lastProcessedPhien || { hu: null, md5: null };
      console.log('Prediction history loaded successfully');
    }
  } catch (error) {
    console.error('Error loading prediction history:', error.message);
  }
}

function savePredictionHistory() {
  try {
    const dataToSave = {
      history: predictionHistory,
      lastProcessedPhien,
      lastSaved: new Date().toISOString()
    };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (error) {
    console.error('Error saving prediction history:', error.message);
  }
}

function normalizeResult(result) {
  if (result === 'Tài' || result === 'tài') return 'tai';
  if (result === 'Xỉu' || result === 'xỉu') return 'xiu';
  return result.toLowerCase();
}

// Hàm xử lý API cũ (giống code Python)
function processOldApiData(apiData, isMD5 = false) {
  if (!apiData || !apiData.data || !Array.isArray(apiData.data)) {
    return [];
  }
  
  const results = [];
  
  apiData.data.forEach(game => {
    const cmd = game.cmd;
    
    if (isMD5 && cmd === 2006) {
      // Xử lý MD5
      const { sid, d1, d2, d3 } = game;
      if (sid && d1 !== undefined && d2 !== undefined && d3 !== undefined) {
        const total = d1 + d2 + d3;
        const ket_qua = total <= 10 ? 'Xỉu' : 'Tài';
        
        results.push({
          Phien: sid,
          Ket_qua: ket_qua,
          Xuc_xac_1: d1,
          Xuc_xac_2: d2,
          Xuc_xac_3: d3,
          Tong: total
        });
      }
    } else if (!isMD5 && cmd === 1003) {
      // Xử lý TX thường
      const { d1, d2, d3 } = game;
      // Tìm sid từ cmd 1008 trong cùng response
      const sidGame = apiData.data.find(g => g.cmd === 1008);
      const sid = sidGame ? sidGame.sid : null;
      
      if (sid && d1 !== undefined && d2 !== undefined && d3 !== undefined) {
        const total = d1 + d2 + d3;
        const ket_qua = total <= 10 ? 'Xỉu' : 'Tài';
        
        results.push({
          Phien: sid,
          Ket_qua: ket_qua,
          Xuc_xac_1: d1,
          Xuc_xac_2: d2,
          Xuc_xac_3: d3,
          Tong: total
        });
      }
    }
  });
  
  // Sắp xếp theo phiên giảm dần (mới nhất đầu tiên)
  results.sort((a, b) => b.Phien - a.Phien);
  
  // Giới hạn số lượng
  return results.slice(0, 50);
}

async function fetchDataHu() {
  try {
    const response = await axios.get(API_URL_TX, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    
    return processOldApiData(response.data, false);
  } catch (error) {
    console.error('Error fetching HU data from old API:', error.message);
    return [];
  }
}

async function fetchDataMd5() {
  try {
    const response = await axios.get(API_URL_MD5, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    
    return processOldApiData(response.data, true);
  } catch (error) {
    console.error('Error fetching MD5 data from old API:', error.message);
    return [];
  }
}

// ==================== PATTERN ANALYSIS ====================
function analyzeCauBet(results) {
  if (results.length < 3) return { detected: false };
  
  let streakType = results[0];
  let streakLength = 1;
  
  for (let i = 1; i < results.length; i++) {
    if (results[i] === streakType) {
      streakLength++;
    } else {
      break;
    }
  }
  
  if (streakLength >= 3) {
    return { 
      detected: true, 
      type: streakType, 
      length: streakLength,
      prediction: streakLength >= 6 ? (streakType === 'Tài' ? 'Xỉu' : 'Tài') : streakType,
      confidence: Math.min(15, streakLength * 3),
      name: `Cầu Bệt ${streakLength} phiên`
    };
  }
  
  return { detected: false };
}

function analyzeCauDao11(results) {
  if (results.length < 4) return { detected: false };
  
  let alternatingLength = 1;
  for (let i = 1; i < Math.min(results.length, 10); i++) {
    if (results[i] !== results[i - 1]) {
      alternatingLength++;
    } else {
      break;
    }
  }
  
  if (alternatingLength >= 4) {
    return { 
      detected: true, 
      length: alternatingLength,
      prediction: results[0] === 'Tài' ? 'Xỉu' : 'Tài',
      confidence: Math.min(14, alternatingLength * 2 + 4),
      name: `Cầu Đảo 1-1 (${alternatingLength} phiên)`
    };
  }
  
  return { detected: false };
}

function analyzeCau3Van1(results) {
  if (results.length < 4) return { detected: false };
  
  const last4 = results.slice(0, 4);
  const taiCount = last4.filter(r => r === 'Tài').length;
  
  if (taiCount === 3) {
    return { 
      detected: true, 
      pattern: '3-1',
      majority: 'Tài',
      prediction: 'Xỉu',
      confidence: 8,
      name: 'Cầu 3 Ván 1 (3T-1X)'
    };
  } else if (taiCount === 1) {
    return { 
      detected: true, 
      pattern: '3-1',
      majority: 'Xỉu',
      prediction: 'Tài',
      confidence: 8,
      name: 'Cầu 3 Ván 1 (3X-1T)'
    };
  }
  
  return { detected: false };
}

function analyzeDistribution(data, windowSize = 50) {
  const window = data.slice(0, windowSize);
  const taiCount = window.filter(d => d.Ket_qua === 'Tài').length;
  const xiuCount = window.length - taiCount;
  
  return {
    taiPercent: (taiCount / window.length) * 100,
    xiuPercent: (xiuCount / window.length) * 100,
    taiCount,
    xiuCount,
    total: window.length,
    imbalance: Math.abs(taiCount - xiuCount) / window.length
  };
}

// ==================== PREDICTION ENGINE ====================
function calculatePrediction(data, type) {
  if (data.length === 0) {
    return {
      prediction: 'tai',
      confidence: 50,
      factors: ['Không có dữ liệu'],
      detailedAnalysis: {
        totalPatterns: 0,
        taiVotes: 0,
        xiuVotes: 0,
        taiScore: 0,
        xiuScore: 0,
        topPattern: 'N/A',
        distribution: { taiPercent: 50, xiuPercent: 50, imbalance: 0 }
      }
    };
  }
  
  const last50 = data.slice(0, 50);
  const results = last50.map(d => d.Ket_qua);
  
  let predictions = [];
  let factors = [];
  
  const cauBet = analyzeCauBet(results);
  if (cauBet.detected) {
    predictions.push({ prediction: cauBet.prediction, confidence: cauBet.confidence, priority: 10, name: cauBet.name });
    factors.push(cauBet.name);
  }
  
  const cauDao11 = analyzeCauDao11(results);
  if (cauDao11.detected) {
    predictions.push({ prediction: cauDao11.prediction, confidence: cauDao11.confidence, priority: 9, name: cauDao11.name });
    factors.push(cauDao11.name);
  }
  
  const cau3Van1 = analyzeCau3Van1(results);
  if (cau3Van1.detected) {
    predictions.push({ prediction: cau3Van1.prediction, confidence: cau3Van1.confidence, priority: 6, name: cau3Van1.name });
    factors.push(cau3Van1.name);
  }
  
  const distribution = analyzeDistribution(last50);
  if (distribution.imbalance > 0.2) {
    const minority = distribution.taiPercent < 50 ? 'Tài' : 'Xỉu';
    predictions.push({ prediction: minority, confidence: 6, priority: 5, name: 'Phân bố lệch' });
    factors.push(`Phân bố lệch (T:${distribution.taiPercent.toFixed(0)}% - X:${distribution.xiuPercent.toFixed(0)}%)`);
  }
  
  if (predictions.length === 0) {
    predictions.push({ prediction: results[0] || 'Tài', confidence: 5, priority: 1, name: 'Cầu Tự Nhiên' });
    factors.push('Cầu Tự Nhiên (Theo Ván Trước)');
  }
  
  predictions.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);
  
  const taiVotes = predictions.filter(p => p.prediction === 'Tài');
  const xiuVotes = predictions.filter(p => p.prediction === 'Xỉu');
  
  const taiScore = taiVotes.reduce((sum, p) => sum + p.confidence * p.priority, 0);
  const xiuScore = xiuVotes.reduce((sum, p) => sum + p.confidence * p.priority, 0);
  
  let finalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
  
  let baseConfidence = 50;
  const topPredictions = predictions.slice(0, 3);
  topPredictions.forEach(p => {
    if (p.prediction === finalPrediction) {
      baseConfidence += p.confidence;
    }
  });
  
  const agreementRatio = (finalPrediction === 'Tài' ? taiVotes.length : xiuVotes.length) / predictions.length;
  baseConfidence += Math.round(agreementRatio * 10);
  
  const randomAdjust = (Math.random() * 4) - 2;
  let finalConfidence = Math.round(baseConfidence + randomAdjust);
  
  finalConfidence = Math.max(50, Math.min(85, finalConfidence));
  
  return {
    prediction: finalPrediction,
    confidence: finalConfidence,
    factors,
    detailedAnalysis: {
      totalPatterns: predictions.length,
      taiVotes: taiVotes.length,
      xiuVotes: xiuVotes.length,
      taiScore,
      xiuScore,
      topPattern: predictions[0]?.name || 'N/A',
      distribution
    }
  };
}

// ==================== PREDICTION HISTORY MANAGEMENT ====================
function savePredictionToHistory(type, phien, prediction, confidence) {
  const record = {
    phien: phien.toString(),
    du_doan: normalizeResult(prediction),
    ti_le: `${confidence}%`,
    id: '@Kapubb',
    timestamp: new Date().toISOString(),
    verified: false,
    actual: null,
    status: null
  };
  
  predictionHistory[type].unshift(record);
  
  if (predictionHistory[type].length > MAX_HISTORY) {
    predictionHistory[type] = predictionHistory[type].slice(0, MAX_HISTORY);
  }
  
  return record;
}

function recordPrediction(type, phien, prediction, confidence, factors) {
  const record = {
    phien: phien.toString(),
    prediction,
    confidence,
    factors,
    timestamp: new Date().toISOString(),
    verified: false,
    actual: null,
    isCorrect: null
  };
  
  learningData[type].predictions.unshift(record);
  learningData[type].totalPredictions++;
  
  if (learningData[type].predictions.length > 500) {
    learningData[type].predictions = learningData[type].predictions.slice(0, 500);
  }
  
  saveLearningData();
}

async function verifyPredictions(type, currentData) {
  let updated = false;
  
  for (const pred of learningData[type].predictions) {
    if (pred.verified) continue;
    
    const actualResult = currentData.find(d => d.Phien.toString() === pred.phien);
    if (actualResult) {
      pred.verified = true;
      pred.actual = actualResult.Ket_qua;
      pred.isCorrect = pred.prediction === actualResult.Ket_qua;
      
      // Cập nhật thống kê
      if (pred.isCorrect) {
        learningData[type].correctPredictions++;
        learningData[type].streakAnalysis.wins++;
        
        if (learningData[type].streakAnalysis.currentStreak >= 0) {
          learningData[type].streakAnalysis.currentStreak++;
        } else {
          learningData[type].streakAnalysis.currentStreak = 1;
        }
        
        if (learningData[type].streakAnalysis.currentStreak > learningData[type].streakAnalysis.bestStreak) {
          learningData[type].streakAnalysis.bestStreak = learningData[type].streakAnalysis.currentStreak;
        }
      } else {
        learningData[type].streakAnalysis.losses++;
        
        if (learningData[type].streakAnalysis.currentStreak <= 0) {
          learningData[type].streakAnalysis.currentStreak--;
        } else {
          learningData[type].streakAnalysis.currentStreak = -1;
        }
        
        if (learningData[type].streakAnalysis.currentStreak < learningData[type].streakAnalysis.worstStreak) {
          learningData[type].streakAnalysis.worstStreak = learningData[type].streakAnalysis.currentStreak;
        }
      }
      
      // Cập nhật lịch sử dự đoán với trạng thái
      const historyRecord = predictionHistory[type].find(h => h.phien === pred.phien);
      if (historyRecord) {
        historyRecord.verified = true;
        historyRecord.actual = pred.actual;
        historyRecord.status = pred.isCorrect ? '✅' : '❌';
      }
      
      learningData[type].recentAccuracy.push(pred.isCorrect ? 1 : 0);
      if (learningData[type].recentAccuracy.length > 50) {
        learningData[type].recentAccuracy.shift();
      }
      
      updated = true;
    }
  }
  
  if (updated) {
    learningData[type].lastUpdate = new Date().toISOString();
    saveLearningData();
    savePredictionHistory();
  }
}

// ==================== AUTO PROCESSING ====================
async function autoProcessPredictions() {
  try {
    // Xử lý HU
    const dataHu = await fetchDataHu();
    if (dataHu && dataHu.length > 0) {
      const latestHuPhien = dataHu[0].Phien;
      const nextHuPhien = latestHuPhien + 1;
      
      if (lastProcessedPhien.hu !== nextHuPhien) {
        await verifyPredictions('hu', dataHu);
        
        const result = calculatePrediction(dataHu, 'hu');
        savePredictionToHistory('hu', nextHuPhien, result.prediction, result.confidence);
        recordPrediction('hu', nextHuPhien, result.prediction, result.confidence, result.factors);
        
        lastProcessedPhien.hu = nextHuPhien;
        console.log(`[Auto] Hu phien ${nextHuPhien}: ${result.prediction} (${result.confidence}%)`);
      }
    }
    
    // Xử lý MD5
    const dataMd5 = await fetchDataMd5();
    if (dataMd5 && dataMd5.length > 0) {
      const latestMd5Phien = dataMd5[0].Phien;
      const nextMd5Phien = latestMd5Phien + 1;
      
      if (lastProcessedPhien.md5 !== nextMd5Phien) {
        await verifyPredictions('md5', dataMd5);
        
        const result = calculatePrediction(dataMd5, 'md5');
        savePredictionToHistory('md5', nextMd5Phien, result.prediction, result.confidence);
        recordPrediction('md5', nextMd5Phien, result.prediction, result.confidence, result.factors);
        
        lastProcessedPhien.md5 = nextMd5Phien;
        console.log(`[Auto] MD5 phien ${nextMd5Phien}: ${result.prediction} (${result.confidence}%)`);
      }
    }
    
    savePredictionHistory();
    
  } catch (error) {
    console.error('[Auto] Error processing predictions:', error.message);
  }
}

// ==================== EXPRESS ENDPOINTS (ĐÃ ĐỔI TÊN) ====================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send('Prediction API - ID: @Kapubb\nEndpoints: /hit-hu /hit-md5 /hit-hu/lichsu /hit-md5/lichsu');
});

// ENDPOINT MỚI: /hit-hu (thay cho /lc79-hu)
app.get('/hit-hu', async (req, res) => {
  try {
    const data = await fetchDataHu();
    
    // Tìm phiên tiếp theo
    let nextPhien = 1;
    if (data && data.length > 0) {
      const latestPhien = data[0].Phien;
      nextPhien = latestPhien + 1;
    }
    
    const result = calculatePrediction(data, 'hu');
    
    // Lưu vào lịch sử
    savePredictionToHistory('hu', nextPhien, result.prediction, result.confidence);
    recordPrediction('hu', nextPhien, result.prediction, result.confidence, result.factors);
    
    // Xác minh dự đoán cũ
    if (data && data.length > 0) {
      await verifyPredictions('hu', data);
    }
    
    res.json({
      phien: nextPhien.toString(),
      du_doan: normalizeResult(result.prediction),
      ti_le: `${result.confidence}%`,
      id: '@Kapubb'
    });
  } catch (error) {
    console.error('Error in /hit-hu:', error);
    res.status(500).json({ 
      error: 'Lỗi server',
      phien: '1',
      du_doan: 'tai',
      ti_le: '50%',
      id: '@Kapubb'
    });
  }
});

// ENDPOINT MỚI: /hit-md5 (thay cho /lc79-md5)
app.get('/hit-md5', async (req, res) => {
  try {
    const data = await fetchDataMd5();
    
    // Tìm phiên tiếp theo
    let nextPhien = 1;
    if (data && data.length > 0) {
      const latestPhien = data[0].Phien;
      nextPhien = latestPhien + 1;
    }
    
    const result = calculatePrediction(data, 'md5');
    
    // Lưu vào lịch sử
    savePredictionToHistory('md5', nextPhien, result.prediction, result.confidence);
    recordPrediction('md5', nextPhien, result.prediction, result.confidence, result.factors);
    
    // Xác minh dự đoán cũ
    if (data && data.length > 0) {
      await verifyPredictions('md5', data);
    }
    
    res.json({
      phien: nextPhien.toString(),
      du_doan: normalizeResult(result.prediction),
      ti_le: `${result.confidence}%`,
      id: '@Kapubb'
    });
  } catch (error) {
    console.error('Error in /hit-md5:', error);
    res.status(500).json({ 
      error: 'Lỗi server',
      phien: '1',
      du_doan: 'tai',
      ti_le: '50%',
      id: '@Kapubb'
    });
  }
});

// ENDPOINT MỚI: /hit-hu/lichsu
app.get('/hit-hu/lichsu', async (req, res) => {
  try {
    const data = await fetchDataHu();
    if (data && data.length > 0) {
      await verifyPredictions('hu', data);
    }
    
    res.json({
      type: 'HIT - Tài Xỉu Hũ',
      history: predictionHistory.hu.map(record => ({
        phien: record.phien,
        du_doan: record.du_doan,
        ti_le: record.ti_le,
        id: record.id,
        timestamp: record.timestamp,
        ket_qua_thuc_te: record.actual,
        status: record.status
      })),
      total: predictionHistory.hu.length,
      stats: {
        totalPredictions: learningData.hu.totalPredictions,
        correctPredictions: learningData.hu.correctPredictions,
        accuracy: learningData.hu.totalPredictions > 0 
          ? ((learningData.hu.correctPredictions / learningData.hu.totalPredictions) * 100).toFixed(2) + '%'
          : '0%'
      }
    });
  } catch (error) {
    res.json({
      type: 'HIT - Tài Xỉu Hũ',
      history: predictionHistory.hu,
      total: predictionHistory.hu.length
    });
  }
});

// ENDPOINT MỚI: /hit-md5/lichsu
app.get('/hit-md5/lichsu', async (req, res) => {
  try {
    const data = await fetchDataMd5();
    if (data && data.length > 0) {
      await verifyPredictions('md5', data);
    }
    
    res.json({
      type: 'HIT - Tài Xỉu MD5',
      history: predictionHistory.md5.map(record => ({
        phien: record.phien,
        du_doan: record.du_doan,
        ti_le: record.ti_le,
        id: record.id,
        timestamp: record.timestamp,
        ket_qua_thuc_te: record.actual,
        status: record.status
      })),
      total: predictionHistory.md5.length,
      stats: {
        totalPredictions: learningData.md5.totalPredictions,
        correctPredictions: learningData.md5.correctPredictions,
        accuracy: learningData.md5.totalPredictions > 0 
          ? ((learningData.md5.correctPredictions / learningData.md5.totalPredictions) * 100).toFixed(2) + '%'
          : '0%'
      }
    });
  } catch (error) {
    res.json({
      type: 'HIT - Tài Xỉu MD5',
      history: predictionHistory.md5,
      total: predictionHistory.md5.length
    });
  }
});

// ENDPOINT MỚI: /hit-hu/analysis
app.get('/hit-hu/analysis', async (req, res) => {
  try {
    const data = await fetchDataHu();
    
    const result = calculatePrediction(data, 'hu');
    res.json({
      prediction: normalizeResult(result.prediction),
      confidence: result.confidence,
      factors: result.factors,
      analysis: result.detailedAnalysis,
      stats: {
        totalPredictions: learningData.hu.totalPredictions,
        correctPredictions: learningData.hu.correctPredictions,
        accuracy: learningData.hu.totalPredictions > 0 
          ? ((learningData.hu.correctPredictions / learningData.hu.totalPredictions) * 100).toFixed(2) + '%'
          : '0%',
        currentStreak: learningData.hu.streakAnalysis.currentStreak
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// ENDPOINT MỚI: /hit-md5/analysis
app.get('/hit-md5/analysis', async (req, res) => {
  try {
    const data = await fetchDataMd5();
    
    const result = calculatePrediction(data, 'md5');
    res.json({
      prediction: normalizeResult(result.prediction),
      confidence: result.confidence,
      factors: result.factors,
      analysis: result.detailedAnalysis,
      stats: {
        totalPredictions: learningData.md5.totalPredictions,
        correctPredictions: learningData.md5.correctPredictions,
        accuracy: learningData.md5.totalPredictions > 0 
          ? ((learningData.md5.correctPredictions / learningData.md5.totalPredictions) * 100).toFixed(2) + '%'
          : '0%',
        currentStreak: learningData.md5.streakAnalysis.currentStreak
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// ENDPOINT MỚI: /hit-hu/stats
app.get('/hit-hu/stats', (req, res) => {
  const stats = learningData.hu;
  const accuracy = stats.totalPredictions > 0 
    ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2)
    : 0;
  
  const recentAcc = stats.recentAccuracy.length > 0
    ? (stats.recentAccuracy.reduce((a, b) => a + b, 0) / stats.recentAccuracy.length * 100).toFixed(2)
    : 0;
  
  res.json({
    type: 'HIT - Tài Xỉu Hũ',
    totalPredictions: stats.totalPredictions,
    correctPredictions: stats.correctPredictions,
    overallAccuracy: `${accuracy}%`,
    recentAccuracy: `${recentAcc}%`,
    streakAnalysis: stats.streakAnalysis,
    lastUpdate: stats.lastUpdate,
    predictionHistory: {
      total: predictionHistory.hu.length,
      verified: predictionHistory.hu.filter(h => h.verified).length,
      correct: predictionHistory.hu.filter(h => h.status === '✅').length
    }
  });
});

// ENDPOINT MỚI: /hit-md5/stats
app.get('/hit-md5/stats', (req, res) => {
  const stats = learningData.md5;
  const accuracy = stats.totalPredictions > 0 
    ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2)
    : 0;
  
  const recentAcc = stats.recentAccuracy.length > 0
    ? (stats.recentAccuracy.reduce((a, b) => a + b, 0) / stats.recentAccuracy.length * 100).toFixed(2)
    : 0;
  
  res.json({
    type: 'HIT - Tài Xỉu MD5',
    totalPredictions: stats.totalPredictions,
    correctPredictions: stats.correctPredictions,
    overallAccuracy: `${accuracy}%`,
    recentAccuracy: `${recentAcc}%`,
    streakAnalysis: stats.streakAnalysis,
    lastUpdate: stats.lastUpdate,
    predictionHistory: {
      total: predictionHistory.md5.length,
      verified: predictionHistory.md5.filter(h => h.verified).length,
      correct: predictionHistory.md5.filter(h => h.status === '✅').length
    }
  });
});

// ==================== INITIALIZATION ====================
loadLearningData();
loadPredictionHistory();

// Schedule auto processing every 30 seconds
cron.schedule('*/30 * * * * *', () => {
  autoProcessPredictions();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log('HIT - Tài Xỉu Prediction API');
  console.log('ID: @Kapubb');
  console.log('');
  console.log('API SOURCES (OLD API):');
  console.log('  - TX Hũ: ' + API_URL_TX);
  console.log('  - TX MD5: ' + API_URL_MD5);
  console.log('');
  console.log('NEW ENDPOINTS:');
  console.log('  / - Homepage');
  console.log('  /hit-hu - Dự đoán Tài Xỉu Hũ');
  console.log('  /hit-md5 - Dự đoán Tài Xỉu MD5');
  console.log('  /hit-hu/lichsu - Lịch sử dự đoán Hũ (có trạng thái đúng/sai)');
  console.log('  /hit-md5/lichsu - Lịch sử dự đoán MD5 (có trạng thái đúng/sai)');
  console.log('  /hit-hu/analysis - Phân tích chi tiết Hũ');
  console.log('  /hit-md5/analysis - Phân tích chi tiết MD5');
  console.log('  /hit-hu/stats - Thống kê dự đoán Hũ');
  console.log('  /hit-md5/stats - Thống kê dự đoán MD5');
});
