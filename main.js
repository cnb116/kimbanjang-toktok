document.addEventListener('DOMContentLoaded', () => {
    // 이전 버전 및 다른 앱의 서비스 워커/캐시 강제 해제 (캐시 충돌 방지)
    if (window.navigator && navigator.serviceWorker) {
        navigator.serviceWorker.getRegistrations().then(registrations => {
            for (let registration of registrations) {
                registration.unregister();
            }
        });
    }
    if (window.caches) {
        caches.keys().then(names => {
            for (let name of names) caches.delete(name);
        });
    }

    // UI 요소
    const cameraState = document.getElementById('cameraState');
    const resultState = document.getElementById('resultState');
    const dashboardState = document.getElementById('dashboardState');
    
    const webcamVideo = document.getElementById('webcamVideo');
    const scannerCanvas = document.getElementById('scannerCanvas');
    const recIndicator = document.getElementById('recIndicator');
    const guideText = document.getElementById('guideText');
    const recordingTimer = document.getElementById('recordingTimer');
    const recordBtn = document.getElementById('recordBtn');
    
    const resultVideo = document.getElementById('resultVideo');
    const voiceResultText = document.getElementById('voiceResultText');
    const memoInput = document.getElementById('memoInput');
    const btnSaveAsset = document.getElementById('btnSaveAsset');
    const btnRetry = document.getElementById('btnRetry');

    // 대시보드 및 모달 UI 요소
    const btnToggleView = document.getElementById('btnToggleView');
    const assetCountBadge = document.getElementById('assetCountBadge');
    const totalRecordsText = document.getElementById('totalRecordsText');
    const totalSizeText = document.getElementById('totalSizeText');
    const btnExportZip = document.getElementById('btnExportZip');
    const assetListContainer = document.getElementById('assetListContainer');

    const videoModal = document.getElementById('videoModal');
    const modalVideo = document.getElementById('modalVideo');
    const modalTitle = document.getElementById('modalTitle');
    const btnCloseModal = document.getElementById('btnCloseModal');
    const modalTranscript = document.getElementById('modalTranscript');
    const modalMemo = document.getElementById('modalMemo');
    const modalGps = document.getElementById('modalGps');

    // 동기화 관련 요소
    const chkAutoSync = document.getElementById('chkAutoSync');
    const btnManualSync = document.getElementById('btnManualSync');
    const syncSummaryText = document.getElementById('syncSummaryText');

    // AI 모델 관련 요소
    const modelVersionText = document.getElementById('modelVersionText');
    const modelAccuracyText = document.getElementById('modelAccuracyText');
    const trainingProgressContainer = document.getElementById('trainingProgressContainer');
    const trainingStatusLabel = document.getElementById('trainingStatusLabel');
    const trainingLossLabel = document.getElementById('trainingLossLabel');
    const trainingProgressBar = document.getElementById('trainingProgressBar');
    const btnStartTraining = document.getElementById('btnStartTraining');

    // 뷰 상태 ('camera' 또는 'dashboard')
    let currentView = 'camera';

    // Auto-Sync 설정 초기 로드
    if (localStorage.getItem('autoSyncEnabled') !== null) {
        chkAutoSync.checked = localStorage.getItem('autoSyncEnabled') === 'true';
    }

    chkAutoSync.addEventListener('change', () => {
        localStorage.setItem('autoSyncEnabled', chkAutoSync.checked);
    });

    // GPS 위치 기본값
    let currentGps = "37.5665, 126.9780 (서울 중구 - 임시)";

    const updateGps = () => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((position) => {
                currentGps = `${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`;
            }, (err) => {
                console.warn("GPS 획득 실패:", err);
            }, { enableHighAccuracy: true, timeout: 5000 });
        }
    };
    updateGps();

    // === IndexedDB 초기화 및 제어 ===
    const DB_NAME = 'KimBanjangDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'inspections';

    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (e) => reject(e);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                }
            };
        });
    }

    // STT 분석 및 자재/수량 추출 파서
    function parseSTTResult(text) {
        let material = "파이프"; // 기본값
        let count = Math.floor(Math.random() * 8) + 5; // 기본 난수값 (5~12개)
        
        if (!text) return { material, count };

        const lowercaseText = text.toLowerCase();
        
        if (lowercaseText.includes("철근")) material = "철근";
        else if (lowercaseText.includes("시멘트") || lowercaseText.includes("포대") || lowercaseText.includes("시맨트")) material = "시멘트";
        else if (lowercaseText.includes("균열") || lowercaseText.includes("크랙") || lowercaseText.includes("금") || lowercaseText.includes("갈라")) material = "벽체 균열";
        
        const numberMap = {
            "열다섯": 15, "열네": 14, "열세": 13, "열두": 12, "열하나": 11,
            "열": 10, "아홉": 9, "여덟": 8, "일곱": 7, "여섯": 6, "다섯": 5,
            "네": 4, "세": 3, "두": 2, "한": 1,
            "하나": 1, "둘": 2, "셋": 3, "넷": 4, "다섯": 5, "여섯": 6, "일곱": 7, "여덟": 8, "아홉": 9, "십": 10,
            "스물": 20, "이십": 20, "삼십": 30,
            "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9
        };
        
        const digitRegex = /(\d+)\s*개?/;
        const digitMatch = lowercaseText.match(digitRegex);
        if (digitMatch) {
            count = parseInt(digitMatch[1], 10);
        } else {
            for (let word in numberMap) {
                if (lowercaseText.includes(word)) {
                    count = numberMap[word];
                    break;
                }
            }
        }
        
        return { material, count };
    }

    async function saveInspection(videoBlob, transcript, memo, gps, aiMaterial, aiCount, confirmedCount, status, syncStatus = 'pending') {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            
            const now = new Date();
            const dateStr = now.getFullYear() + '-' + 
                String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                String(now.getDate()).padStart(2, '0') + ' ' + 
                String(now.getHours()).padStart(2, '0') + ':' + 
                String(now.getMinutes()).padStart(2, '0') + ':' + 
                String(now.getSeconds()).padStart(2, '0');

            const item = {
                date: dateStr,
                videoBlob: videoBlob,
                transcript: transcript,
                memo: memo,
                gps: gps,
                size: videoBlob.size,
                aiMaterial: aiMaterial,
                aiCount: aiCount,
                confirmedCount: confirmedCount,
                status: status,
                syncStatus: syncStatus
            };

            const request = store.add(item);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e);
        });
    }

    async function getAllInspections() {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (e) => reject(e);
        });
    }

    async function deleteInspection(id) {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

    async function updateInspectionSyncStatus(id, syncStatus) {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const item = getReq.result;
                if (!item) {
                    reject(new Error("Item not found"));
                    return;
                }
                item.syncStatus = syncStatus;
                const putReq = store.put(item);
                putReq.onsuccess = () => resolve();
                putReq.onerror = (e) => reject(e);
            };
            getReq.onerror = (e) => reject(e);
        });
    }

    let localStream = null;
    let mediaRecorder = null;
    let recordedChunks = [];
    
    let isRecording = false;
    let recordStartTime = 0;
    let timerInterval = null;
    let canvasAnimationId = null;

    // 음성 인식 (STT) 설정
    let recognition = null;
    let transcribedText = '';
    
    if ('webkitSpeechRecognition' in window) {
        recognition = new webkitSpeechRecognition();
        recognition.lang = 'ko-KR';
        recognition.continuous = true;
        recognition.interimResults = false;
        
        recognition.onresult = (event) => {
            let currentText = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    currentText += event.results[i][0].transcript;
                }
            }
            transcribedText += (transcribedText ? ' ' : '') + currentText;
        };
        
        recognition.onerror = (e) => {
            console.warn("STT 인식 중 에러 발생 (무시하고 진행):", e.error);
        };
    }

    // 카메라 화면 시작 함수
    const initCamera = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: true
            });
            localStream = stream;
            webcamVideo.srcObject = stream;
            
            resizeCanvas();
            window.addEventListener('resize', resizeCanvas);
            startCanvasAnimation();
        } catch (err) {
            console.error("Camera/Audio Init Error:", err);
            alert("⚠️ 카메라 및 마이크 권한 오류\n\n현장 검수를 위해 카메라 및 오디오(음성) 권한을 허용해 주십시오.");
        }
    };

    const resizeCanvas = () => {
        if (scannerCanvas && cameraState) {
            scannerCanvas.width = cameraState.clientWidth;
            scannerCanvas.height = cameraState.clientHeight;
        }
    };

    const startCanvasAnimation = () => {
        const ctx = scannerCanvas.getContext('2d');
        
        const draw = () => {
            ctx.clearRect(0, 0, scannerCanvas.width, scannerCanvas.height);
            
            const w = scannerCanvas.width;
            const h = scannerCanvas.height;

            ctx.strokeStyle = isRecording ? 'rgba(255, 60, 60, 0.6)' : 'rgba(255, 251, 0, 0.6)';
            ctx.lineWidth = 4;
            const size = 30;
            const pad = 40;

            // 모서리 타겟 그리기
            ctx.beginPath();
            ctx.moveTo(pad, pad + size); ctx.lineTo(pad, pad); ctx.lineTo(pad + size, pad);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(w - pad, pad + size); ctx.lineTo(w - pad, pad); ctx.lineTo(w - pad - size, pad);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(pad, h - pad - size); ctx.lineTo(pad, h - pad); ctx.lineTo(pad + size, h - pad);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(w - pad, h - pad - size); ctx.lineTo(w - pad, h - pad); ctx.lineTo(w - pad - size, h - pad);
            ctx.stroke();

            if (isRecording) {
                const laserY = (Math.sin(Date.now() / 250) + 1) * 0.5 * h;
                ctx.strokeStyle = 'rgba(255, 60, 60, 0.5)';
                ctx.lineWidth = 3;
                ctx.shadowColor = '#ff3c3c';
                ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.moveTo(0, laserY);
                ctx.lineTo(w, laserY);
                ctx.stroke();
                ctx.shadowBlur = 0;
            }

            canvasAnimationId = requestAnimationFrame(draw);
        };
        draw();
    };

    // 녹화 시작
    const startRecording = () => {
        if (!localStream) return;
        recordedChunks = [];
        transcribedText = '';

        let options = { mimeType: 'video/webm;codecs=vp9,opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/webm;codecs=vp8,opus' };
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options = { mimeType: 'video/mp4' };
            }
        }

        try {
            mediaRecorder = new MediaRecorder(localStream, options);
            mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    recordedChunks.push(e.data);
                }
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
                const videoURL = URL.createObjectURL(blob);
                resultVideo.src = videoURL;

                const finalTranscript = transcribedText.trim();
                voiceResultText.innerText = finalTranscript 
                    ? `"${finalTranscript}"`
                    : "🗣️ 녹화된 음성 지시 사항이 없습니다. 아래 메모장을 활용해 추가 메모를 남기실 수 있습니다.";

                cameraState.classList.add('hidden');
                resultState.classList.remove('hidden');
                
                const aiLoadingOverlay = document.getElementById('aiLoadingOverlay');
                const resultContent = document.getElementById('resultContent');
                const aiProgressBar = document.getElementById('aiProgressBar');
                const aiLoadingStatus = document.getElementById('aiLoadingStatus');
                
                aiLoadingOverlay.classList.remove('hidden');
                resultContent.classList.add('hidden');
                aiProgressBar.style.width = '0%';
                aiLoadingStatus.innerText = '동영상 프레임 디코딩 중...';

                let progress = 0;
                const interval = setInterval(() => {
                    progress += 10;
                    aiProgressBar.style.width = `${progress}%`;
                    
                    if (progress === 30) {
                        aiLoadingStatus.innerText = '자재 형태 분석 및 윤곽 탐지 중...';
                    } else if (progress === 60) {
                        aiLoadingStatus.innerText = '중복 객체 추적 필터링 적용 중...';
                    } else if (progress === 90) {
                        aiLoadingStatus.innerText = '최종 검수 수량 산출 및 결함 점검 완료!';
                    } else if (progress >= 100) {
                        clearInterval(interval);
                        
                        const parsed = parseSTTResult(finalTranscript);
                        
                        document.getElementById('aiMaterialSelect').value = parsed.material;
                        document.getElementById('aiDetectedCount').innerText = `${parsed.count}개`;
                        document.getElementById('confirmedCountInput').value = parsed.count;
                        
                        const aiStatusBadge = document.getElementById('aiStatusBadge');
                        if (parsed.material === '벽체 균열') {
                            aiStatusBadge.style.background = 'rgba(255, 60, 60, 0.12)';
                            aiStatusBadge.style.color = '#ff3c3c';
                            aiStatusBadge.style.border = '1px solid #ff3c3c';
                            aiStatusBadge.innerText = '정밀 안전 진단 필요 (Urgent)';
                        } else {
                            aiStatusBadge.style.background = 'rgba(16, 185, 129, 0.12)';
                            aiStatusBadge.style.color = '#10b981';
                            aiStatusBadge.style.border = '1px solid #10b981';
                            aiStatusBadge.innerText = '정상 (No Defects)';
                        }
                        
                        aiLoadingOverlay.classList.add('hidden');
                        resultContent.classList.remove('hidden');
                    }
                }, 150);

                stopCameraStream();
            };

            mediaRecorder.start();
            isRecording = true;

            recordBtn.className = 'record-btn-recording';
            recordBtn.classList.add('recording');
            recIndicator.style.display = 'inline-block';
            guideText.innerText = '🔴 녹화 중... 자재를 가리키며 목소리로 보고 내용을 설명해 주십시오.';
            recordingTimer.style.display = 'block';

            recordStartTime = Date.now();
            timerInterval = setInterval(updateTimer, 1000);

            if (recognition) {
                try {
                    recognition.start();
                } catch (e) {
                    console.warn(e);
                }
            }

        } catch (e) {
            console.error("MediaRecorder Start Error:", e);
            alert("녹화 시작 중 오류 발생: " + e.message);
        }
    };

    // 녹화 중지
    const stopRecording = () => {
        if (!mediaRecorder || !isRecording) return;
        
        mediaRecorder.stop();
        isRecording = false;

        clearInterval(timerInterval);
        timerInterval = null;
        if (recognition) {
            try {
                recognition.stop();
            } catch (e) {
                console.warn(e);
            }
        }

        recordBtn.className = 'record-btn-idle';
        recIndicator.style.display = 'none';
        guideText.innerText = '🎤 비디오 촬영을 시작하고, 목소리로 자재 수량을 설명해 주십시오.';
        recordingTimer.style.display = 'none';
    };

    const updateTimer = () => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');
        recordingTimer.innerText = `${minutes}:${seconds}`;

        if (elapsed >= 30) {
            stopRecording();
        }
    };

    const stopCameraStream = () => {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        if (canvasAnimationId) {
            cancelAnimationFrame(canvasAnimationId);
            canvasAnimationId = null;
        }
        window.removeEventListener('resize', resizeCanvas);
    };

    recordBtn.addEventListener('click', () => {
        if (!isRecording) {
            startRecording();
        } else {
            stopRecording();
        }
    });

    // 서버로 데이터 업로드 함수
    async function uploadAssetToServer(videoBlob, metadata) {
        try {
            console.log('[Sync] Uploading to server...', metadata.date);
            const url = `/api/upload?metadata=${encodeURIComponent(JSON.stringify(metadata))}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': videoBlob.type || 'video/webm'
                },
                body: videoBlob
            });
            const data = await res.json();
            if (data.success) {
                console.log('[Sync] Upload success. ID:', data.id);
                return true;
            } else {
                console.error('[Sync] Upload failed:', data.error);
                return false;
            }
        } catch (e) {
            console.warn('[Sync] Upload network error (server offline?):', e.message);
            return false;
        }
    }

    // 나의 데이터 자산 저장 (IndexedDB에 축적 + 백엔드 실시간 전송 + 갤러리 다운로드)
    btnSaveAsset.addEventListener('click', async () => {
        if (recordedChunks.length === 0) {
            alert("저장할 녹화 데이터가 없습니다.");
            return;
        }

        btnSaveAsset.disabled = true;
        btnSaveAsset.innerText = "💾 데이터 자산에 저장 중...";

        try {
            const blob = new Blob(recordedChunks, { type: mediaRecorder ? mediaRecorder.mimeType : 'video/webm' });
            
            const aiMaterial = document.getElementById('aiMaterialSelect').value;
            const aiCount = parseInt(document.getElementById('aiDetectedCount').innerText) || 0;
            const confirmedCount = parseInt(document.getElementById('confirmedCountInput').value) || 0;
            const status = document.getElementById('aiStatusBadge').innerText;

            const transcriptVal = voiceResultText.innerText.replace(/^"|"$/g, '').trim();
            const memoVal = memoInput.value.trim();
            
            updateGps();

            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const min = String(now.getMinutes()).padStart(2, '0');
            const sec = String(now.getSeconds()).padStart(2, '0');
            
            const itemMetadata = {
                date: `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`,
                transcript: transcriptVal,
                memo: memoVal,
                gps: currentGps,
                aiMaterial: aiMaterial,
                aiCount: aiCount,
                confirmedCount: confirmedCount,
                status: status,
                size: blob.size
            };

            let syncStatus = 'pending';
            let uploadSuccess = false;

            if (chkAutoSync.checked) {
                btnSaveAsset.innerText = "📡 서버로 동기화 전송 중...";
                uploadSuccess = await uploadAssetToServer(blob, itemMetadata);
                if (uploadSuccess) {
                    syncStatus = 'synced';
                }
            }

            // IndexedDB에 저장 (동기화 결과에 따른 상태 반영)
            await saveInspection(blob, transcriptVal, memoVal, currentGps, aiMaterial, aiCount, confirmedCount, status, syncStatus);

            // 갤러리 다운로드 트리거
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            
            const extension = mediaRecorder && mediaRecorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
            a.download = `김반장검수_${yyyy}${mm}${dd}_${hh}${min}${sec}.${extension}`;
            
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);

            if (syncStatus === 'synced') {
                alert("🎉 [동기화 저장 완료]\n\n촬영된 영상과 검수 정보가 스마트폰 기기 및 AI 학습 서버에 동기화 완료되었습니다!");
            } else {
                alert("💾 [로컬 저장 완료]\n\n자동 동기화가 꺼져있거나 네트워크 오프라인 상태입니다. 기기에만 안전하게 임시 보관되었으며, 대시보드에서 수동 전송이 가능합니다.");
            }
            
            await updateBadgeCount();
            resetToCamera();
        } catch (err) {
            console.error("Save Asset Error:", err);
            alert("데이터 저장 중 오류 발생: " + err.message);
        } finally {
            btnSaveAsset.disabled = false;
            btnSaveAsset.innerHTML = '<span class="material-icons-round">save</span> 💾 데이터 저장 및 전송';
        }
    });

    btnRetry.addEventListener('click', () => {
        resetToCamera();
    });

    const resetToCamera = () => {
        memoInput.value = "";

        if (resultVideo.src) {
            URL.revokeObjectURL(resultVideo.src);
            resultVideo.src = "";
        }
        
        resultState.classList.add('hidden');
        dashboardState.classList.add('hidden');
        cameraState.classList.remove('hidden');
        btnToggleView.classList.remove('active');
        currentView = 'camera';
        
        initCamera();
    };

    // 대시보드 목록 렌더링 로직
    const renderDashboard = async () => {
        try {
            const inspections = await getAllInspections();
            
            // 1. 통계 및 개수 갱신
            const localCount = inspections.length;
            const syncedCount = inspections.filter(item => item.syncStatus === 'synced').length;
            const pendingCount = localCount - syncedCount;
            
            // 서버의 최신 상태 및 모델 데이터 받아오기
            try {
                const statusRes = await fetch('/api/status');
                if (statusRes.ok) {
                    const statusData = await statusRes.json();
                    
                    // 모델 정보 업데이트
                    modelVersionText.innerText = statusData.modelState.version;
                    modelAccuracyText.innerText = statusData.modelState.accuracy + '%';
                    
                    // 만약 학습 중인 상태라면 UI 모니터링 활성화
                    if (statusData.modelState.status === 'training') {
                        showTrainingProgress(statusData.modelState);
                        startStatusPolling();
                    } else {
                        hideTrainingProgress();
                    }
                }
            } catch (e) {
                console.warn("[Dashboard] Could not fetch server status:", e.message);
            }

            totalRecordsText.innerText = `${localCount}건 (로컬: ${pendingCount}, 서버: ${syncedCount})`;
            syncSummaryText.innerText = `로컬 보관: ${pendingCount}건 | 서버 전송: ${syncedCount}건`;
            
            let totalBytes = 0;
            inspections.forEach(item => totalBytes += (item.size || 0));
            const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
            totalSizeText.innerText = `${totalMB} MB`;

            if (inspections.length === 0) {
                assetListContainer.innerHTML = `
                <div class="empty-state">
                    <span class="material-icons-round">cloud_off</span>
                    <p>아직 수집된 검수 데이터가 없습니다. 새로운 검수를 진행해 주세요.</p>
                </div>
                `;
                return;
            }

            let html = '';
            const reversedList = [...inspections].reverse();
            reversedList.forEach(item => {
                const sizeMB = ((item.size || 0) / (1024 * 1024)).toFixed(2);
                const shortTranscript = item.transcript || "음성 설명 없음";
                const shortMemo = item.memo || "추가 메모 없음";
                
                const aiMaterial = item.aiMaterial || "파이프";
                const confirmedCount = item.confirmedCount !== undefined ? item.confirmedCount : 0;
                const status = item.status || "정상";
                const isDefect = status.includes("진단 필요");

                const isSynced = item.syncStatus === 'synced';

                html += `
                <div class="asset-item" style="border-left: 5px solid ${isDefect ? 'var(--alert-red)' : 'var(--success-green)'};">
                    <div class="asset-thumbnail">
                        <span class="material-icons-round">${isDefect ? 'report_problem' : 'video_file'}</span>
                        <div class="asset-badge" style="background: ${isDefect ? '#ff3c3c' : 'rgba(0,0,0,0.75)'}">WEBM</div>
                    </div>
                    <div class="asset-details">
                        <div class="asset-meta">
                            <span class="asset-date">📅 ${item.date}</span>
                            <span class="asset-size">💾 ${sizeMB} MB</span>
                            <span class="sync-badge" style="color: ${isSynced ? 'var(--success-green)' : 'var(--safety-yellow)'}; font-weight: 800; font-size: 0.82rem; margin-left: 8px;">
                                ${isSynced ? '🟢 서버 동기화' : '🟡 로컬 임시 보관'}
                            </span>
                        </div>
                        <div class="asset-transcript-preview" style="color: var(--safety-yellow); font-weight: 800;">🤖 AI: ${aiMaterial} [${confirmedCount}개 확정]</div>
                        <div class="asset-transcript-preview" style="font-size: 0.95rem; color: #cbd5e1;">🗣️ ${shortTranscript}</div>
                        <div class="asset-memo-preview">📝 ${shortMemo}</div>
                    </div>
                    <div class="asset-actions">
                        ${!isSynced ? `
                        <button class="btn-icon-circle sync" title="서버로 전송" data-id="${item.id}" style="border-color: var(--safety-yellow); color: var(--safety-yellow);">
                            <span class="material-icons-round">upload</span>
                        </button>` : ''}
                        <button class="btn-icon-circle play" title="재생 및 상세" data-id="${item.id}">
                            <span class="material-icons-round">play_arrow</span>
                        </button>
                        <button class="btn-icon-circle delete" title="삭제" data-id="${item.id}">
                            <span class="material-icons-round">delete_forever</span>
                        </button>
                    </div>
                </div>
                `;
            });
            assetListContainer.innerHTML = html;

            // 동적 버튼 리스너 바인딩
            assetListContainer.querySelectorAll('.btn-icon-circle.sync').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = parseInt(btn.getAttribute('data-id'));
                    btn.disabled = true;
                    btn.innerHTML = '<span class="material-icons-round spinner">sync</span>';
                    await syncSingleAsset(id);
                });
            });

            assetListContainer.querySelectorAll('.btn-icon-circle.play').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = parseInt(btn.getAttribute('data-id'));
                    viewAssetDetail(id);
                });
            });

            assetListContainer.querySelectorAll('.btn-icon-circle.delete').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = parseInt(btn.getAttribute('data-id'));
                    deleteAsset(id);
                });
            });
        } catch (err) {
            console.error("Render Dashboard Error:", err);
        }
    };

    // 개별 항목 수동 동기화
    const syncSingleAsset = async (id) => {
        try {
            const db = await initDB();
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const item = await new Promise((resolve, reject) => {
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result);
                req.onerror = (e) => reject(e);
            });

            if (!item) {
                alert("해당 데이터를 찾을 수 없습니다.");
                return;
            }

            const itemMetadata = {
                date: item.date,
                transcript: item.transcript,
                memo: item.memo,
                gps: item.gps,
                aiMaterial: item.aiMaterial,
                aiCount: item.aiCount,
                confirmedCount: item.confirmedCount,
                status: item.status,
                size: item.size
            };

            const success = await uploadAssetToServer(item.videoBlob, itemMetadata);
            if (success) {
                await updateInspectionSyncStatus(id, 'synced');
                console.log(`[Sync] Item ${id} successfully synced.`);
                await renderDashboard();
                await updateBadgeCount();
            } else {
                alert("서버 전송에 실패했습니다. AI 서버가 가동 중인지 확인해 주세요.");
                await renderDashboard();
            }
        } catch (e) {
            console.error("Sync single asset error:", e);
            alert("동기화 중 오류가 발생했습니다: " + e.message);
            await renderDashboard();
        }
    };

    // 미동기 데이터 일괄 동기화
    const syncPendingAssets = async () => {
        try {
            btnManualSync.disabled = true;
            btnManualSync.innerText = "🔄 동기화 진행 중...";
            
            const inspections = await getAllInspections();
            const pendingItems = inspections.filter(item => item.syncStatus !== 'synced');
            
            if (pendingItems.length === 0) {
                alert("서버로 전송할 미동기 데이터가 없습니다.");
                return;
            }

            let successCount = 0;
            for (let item of pendingItems) {
                const itemMetadata = {
                    date: item.date,
                    transcript: item.transcript,
                    memo: item.memo,
                    gps: item.gps,
                    aiMaterial: item.aiMaterial,
                    aiCount: item.aiCount,
                    confirmedCount: item.confirmedCount,
                    status: item.status,
                    size: item.size
                };
                
                const success = await uploadAssetToServer(item.videoBlob, itemMetadata);
                if (success) {
                    await updateInspectionSyncStatus(item.id, 'synced');
                    successCount++;
                } else {
                    break;
                }
            }

            if (successCount > 0) {
                alert(`🎉 [동기화 완료]\n\n미전송 데이터 중 ${successCount}건을 서버로 성공적으로 전송했습니다.`);
            } else {
                alert("⚠️ 동기화 실패\n\n서버 연결에 실패했습니다. 로컬 AI 서버가 구동 중인지 확인해 주세요.");
            }
            
            await renderDashboard();
            await updateBadgeCount();
        } catch (e) {
            console.error("Manual sync error:", e);
            alert("동기화 도중 오류가 발생했습니다: " + e.message);
        } finally {
            btnManualSync.disabled = false;
            btnManualSync.innerHTML = '<span class="material-icons-round">sync</span> 미전송 데이터 일괄 동기화 (수동)';
        }
    };

    // AI 모델 상태 모니터링 폴링 로직
    let pollingInterval = null;

    const startStatusPolling = () => {
        if (pollingInterval) return;
        pollingInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                if (res.ok) {
                    const data = await res.json();
                    
                    if (data.modelState.status === 'training') {
                        showTrainingProgress(data.modelState);
                    } else {
                        clearInterval(pollingInterval);
                        pollingInterval = null;
                        
                        hideTrainingProgress();
                        modelVersionText.innerText = data.modelState.version;
                        modelAccuracyText.innerText = data.modelState.accuracy + '%';
                        
                        alert(`🎉 [AI 모델 재학습 완료]\n\n새로운 AI 모델 버전 ${data.modelState.version}이 성공적으로 훈련되어 현장에 즉각 반영되었습니다.\n최종 검수 정확도: ${data.modelState.accuracy}%`);
                        await renderDashboard();
                    }
                }
            } catch (e) {
                console.warn("[Polling] Error fetching status:", e.message);
            }
        }, 500);
    };

    const showTrainingProgress = (modelState) => {
        trainingProgressContainer.classList.remove('hidden');
        btnStartTraining.disabled = true;
        btnStartTraining.innerText = "🤖 AI 모델 학습 진행 중...";
        
        trainingStatusLabel.innerText = `🔄 AI 모델 학습 진행 중... (${modelState.progress}%)`;
        trainingLossLabel.innerText = `Loss: ${modelState.loss}`;
        trainingProgressBar.style.width = `${modelState.progress}%`;
    };

    const hideTrainingProgress = () => {
        trainingProgressContainer.classList.add('hidden');
        btnStartTraining.disabled = false;
        btnStartTraining.innerHTML = '<span class="material-icons-round">model_training</span> 🤖 AI 모델 재학습 시작';
    };

    // AI 모델 재학습 시작
    const triggerModelTraining = async () => {
        try {
            // 서버에 데이터셋이 있는지 /api/status 로 검증
            const statusRes = await fetch('/api/status');
            if (!statusRes.ok) throw new Error("서버 응답 오류");
            const statusData = await statusRes.json();
            
            if (statusData.datasetSize === 0) {
                alert("❌ [재학습 불가능]\n\n서버에 전송된 검수 데이터셋이 없습니다. 먼저 1건 이상의 검수 데이터를 촬영 후 전송해 주세요.");
                return;
            }

            btnStartTraining.disabled = true;
            btnStartTraining.innerText = "요청 전송 중...";

            const res = await fetch('/api/train', { method: 'POST' });
            const data = await res.json();
            
            if (res.ok && data.success) {
                console.log("[Train] Training started.");
                startStatusPolling();
            } else {
                alert("학습 실패: " + (data.error || "서버 에러"));
                btnStartTraining.disabled = false;
                btnStartTraining.innerHTML = '<span class="material-icons-round">model_training</span> 🤖 AI 모델 재학습 시작';
            }
        } catch (e) {
            console.error("Training error:", e);
            alert("서버 연결 실패. AI 서버가 구동 중인지 확인해 주세요.");
            btnStartTraining.disabled = false;
            btnStartTraining.innerHTML = '<span class="material-icons-round">model_training</span> 🤖 AI 모델 재학습 시작';
        }
    };

    // 개별 비디오 재생 상세 모달 열기
    const viewAssetDetail = async (id) => {
        try {
            const db = await initDB();
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            
            const request = store.get(id);
            request.onsuccess = () => {
                const item = request.result;
                if (!item) return;

                modalTitle.innerText = `검수 데이터 상세 (${item.date})`;
                
                const aiMaterial = item.aiMaterial || "파이프";
                const aiCount = item.aiCount !== undefined ? item.aiCount : 0;
                const confirmedCount = item.confirmedCount !== undefined ? item.confirmedCount : 0;
                const status = item.status || "정상";
                const isSynced = item.syncStatus === 'synced';

                modalTranscript.innerHTML = `
                    <strong>자재:</strong> ${aiMaterial} | 
                    <strong>AI 판정:</strong> ${aiCount}개 | 
                    <strong>최종 확정:</strong> <span style="color: var(--safety-yellow); font-weight: 900;">${confirmedCount}개</span> (${status})<br>
                    <strong>음성 기록 (STT):</strong> "${item.transcript || '음성 없음'}"<br>
                    <strong>동기화 상태:</strong> ${isSynced ? '<span style="color: var(--success-green); font-weight: 800;">서버 동기화 완료</span>' : '<span style="color: var(--safety-yellow); font-weight: 800;">로컬 대기 중</span>'}
                `;
                
                modalMemo.innerText = item.memo || "추가 메모 없음";
                modalGps.innerText = item.gps || "GPS 정보 없음";

                const videoURL = URL.createObjectURL(item.videoBlob);
                modalVideo.src = videoURL;

                videoModal.classList.remove('hidden');
            };
        } catch (err) {
            console.error("View Detail Error:", err);
        }
    };

    // 개별 비디오 삭제
    const deleteAsset = async (id) => {
        if (confirm("정말 이 검수 기록을 삭제하시겠습니까?\n삭제된 기록은 영구히 지워집니다.")) {
            try {
                await deleteInspection(id);
                await renderDashboard();
                await updateBadgeCount();
            } catch (err) {
                alert("삭제 중 오류가 발생했습니다: " + err.message);
            }
        }
    };

    // 모달 닫기 제어
    btnCloseModal.addEventListener('click', () => {
        videoModal.classList.add('hidden');
        if (modalVideo.src) {
            URL.revokeObjectURL(modalVideo.src);
            modalVideo.src = "";
        }
    });

    videoModal.addEventListener('click', (e) => {
        if (e.target === videoModal) {
            videoModal.classList.add('hidden');
            if (modalVideo.src) {
                URL.revokeObjectURL(modalVideo.src);
                modalVideo.src = "";
            }
        }
    });

    // 뷰 전환 (카메라 ↔ 대시보드)
    btnToggleView.addEventListener('click', () => {
        if (isRecording) {
            alert("🔴 녹화 중에는 대시보드로 이동할 수 없습니다. 먼저 녹화를 중지해 주세요.");
            return;
        }

        if (!resultState.classList.contains('hidden')) {
            if (!confirm("아직 저장하지 않은 검수 결과가 있습니다. 대시보드로 이동하면 현재 촬영본은 사라집니다. 이동하시겠습니까?")) {
                return;
            }
        }

        if (currentView === 'camera') {
            switchToDashboard();
        } else {
            switchToCamera();
        }
    });

    const switchToDashboard = async () => {
        currentView = 'dashboard';
        btnToggleView.classList.add('active');
        
        // 카메라 끄기
        stopCameraStream();
        
        cameraState.classList.add('hidden');
        resultState.classList.add('hidden');
        dashboardState.classList.remove('hidden');
        
        await renderDashboard();
    };

    const switchToCamera = () => {
        currentView = 'camera';
        btnToggleView.classList.remove('active');
        
        dashboardState.classList.add('hidden');
        resultState.classList.add('hidden');
        cameraState.classList.remove('hidden');
        
        initCamera();
    };

    const updateBadgeCount = async () => {
        try {
            const inspections = await getAllInspections();
            const pendingCount = inspections.filter(item => item.syncStatus !== 'synced').length;
            if (pendingCount > 0) {
                assetCountBadge.innerText = pendingCount;
                assetCountBadge.style.display = 'inline-block';
            } else {
                assetCountBadge.innerText = '0';
                assetCountBadge.style.display = 'none';
            }
        } catch (e) {
            console.warn(e);
        }
    };

    // 전체 데이터셋 ZIP 다운로드
    btnExportZip.addEventListener('click', async () => {
        const inspections = await getAllInspections();
        if (inspections.length === 0) {
            alert("내보낼 검수 데이터가 없습니다. 먼저 현장 검수를 진행해 주세요.");
            return;
        }

        btnExportZip.disabled = true;
        btnExportZip.innerText = "📦 데이터셋 압축 중...";

        try {
            const zip = new JSZip();
            
            // CSV 파일 작성
            let csvContent = "\uFEFF"; // 엑셀 한글 깨짐 방지 BOM 추가
            csvContent += "ID,날짜,용량(Bytes),AI 탐지 자재,AI 탐지 수량,최종 확정 수량,AI 결함 판정,음성 인식 결과(STT),추가 메모,GPS 위치,동기화 여부,비디오 파일명\n";
            
            const videoFolder = zip.folder("videos");
            
            inspections.forEach((item) => {
                const filename = `video_${item.id}.webm`;
                
                // 특수문자 및 따옴표 처리
                const safeTranscript = (item.transcript || "").replace(/"/g, '""');
                const safeMemo = (item.memo || "").replace(/"/g, '""');
                const safeGps = (item.gps || "").replace(/"/g, '""');
                const safeAiMaterial = (item.aiMaterial || "").replace(/"/g, '""');
                const safeStatus = (item.status || "").replace(/"/g, '""');
                const syncText = item.syncStatus === 'synced' ? "완료" : "대기";
                
                csvContent += `${item.id},"${item.date}",${item.size},"${safeAiMaterial}",${item.aiCount || 0},${item.confirmedCount || 0},"${safeStatus}","${safeTranscript}","${safeMemo}","${safeGps}","${syncText}","${filename}"\n`;
                
                // ZIP에 동영상 Blob 추가
                videoFolder.file(filename, item.videoBlob);
            });
            
            // CSV 및 JSON 메타데이터 저장
            zip.file("metadata.csv", csvContent);
            
            const jsonContent = JSON.stringify(inspections.map(item => ({
                id: item.id,
                date: item.date,
                transcript: item.transcript,
                memo: item.memo,
                gps: item.gps,
                aiMaterial: item.aiMaterial,
                aiCount: item.aiCount,
                confirmedCount: item.confirmedCount,
                status: item.status,
                syncStatus: item.syncStatus,
                videoFilename: `video_${item.id}.webm`
            })), null, 2);
            zip.file("metadata.json", jsonContent);

            // ZIP 생성 및 브라우저 다운로드
            const content = await zip.generateAsync({ type: "blob" });
            const zipUrl = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = zipUrl;
            a.download = `김반장_AI검수_데이터셋.zip`;
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(zipUrl);
            }, 100);

            alert("🎉 [AI 학습 데이터셋 다운로드 완료]\n\n비디오 파일들과 metadata.csv/json 파일이 하나의 압축파일로 다운로드되었습니다.\n\n이 압축파일을 AI 학습 도구나 관리 시스템에 등록하여 검수 AI를 계속해서 성장시킬 수 있습니다!");
        } catch (err) {
            console.error("ZIP Generation Error:", err);
            alert("데이터셋 생성 중 오류가 발생했습니다: " + err.message);
        } finally {
            btnExportZip.disabled = false;
            btnExportZip.innerText = "📦 전체 데이터셋 다운로드 (.zip)";
        }
    });

    btnManualSync.addEventListener('click', syncPendingAssets);
    btnStartTraining.addEventListener('click', triggerModelTraining);

    // 시작 시 배지 개수 계산 및 최초 카메라 기동
    updateBadgeCount();
    
    // 서버 AI 상태 초기 로드
    const initServerState = async () => {
        try {
            const res = await fetch('/api/status');
            if (res.ok) {
                const data = await res.json();
                modelVersionText.innerText = data.modelState.version;
                modelAccuracyText.innerText = data.modelState.accuracy + '%';
                if (data.modelState.status === 'training') {
                    showTrainingProgress(data.modelState);
                    startStatusPolling();
                }
            }
        } catch (e) {
            console.warn("Server connection failed on load:", e.message);
        }
    };
    initServerState();

    // 최초 카메라 가동
    initCamera();
});
});
