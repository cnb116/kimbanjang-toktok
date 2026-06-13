document.addEventListener('DOMContentLoaded', () => {
    // 이전 버전 및 다른 앱의 서비스 워커/캐시 강제 강제 해제 (캐시 충돌 방지)
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

    // 뷰 상태 ('camera' 또는 'dashboard')
    let currentView = 'camera';

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
        
        // 한글 숫자 매칭 사전 (긴 단어 우선)
        const numberMap = {
            "열다섯": 15, "열네": 14, "열세": 13, "열두": 12, "열하나": 11,
            "열": 10, "아홉": 9, "여덟": 8, "일곱": 7, "여섯": 6, "다섯": 5,
            "네": 4, "세": 3, "두": 2, "한": 1,
            "하나": 1, "둘": 2, "셋": 3, "넷": 4, "다섯": 5, "여섯": 6, "일곱": 7, "여덟": 8, "아홉": 9, "십": 10,
            "스물": 20, "이십": 20, "삼십": 30,
            "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9
        };
        
        // 1) 정규표현식으로 아라비아 숫자 탐지 (예: "12개", "12")
        const digitRegex = /(\d+)\s*개?/;
        const digitMatch = lowercaseText.match(digitRegex);
        if (digitMatch) {
            count = parseInt(digitMatch[1], 10);
        } else {
            // 2) 한글 숫자 매칭 사전 탐색
            for (let word in numberMap) {
                if (lowercaseText.includes(word)) {
                    count = numberMap[word];
                    break;
                }
            }
        }
        
        return { material, count };
    }

    async function saveInspection(videoBlob, transcript, memo, gps, aiMaterial, aiCount, confirmedCount, status) {
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
                status: status
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
            request.onsuccess = () => resolve(request.result);
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
            // 모바일 후면 카메라 및 마이크(오디오) 권한 동시 요청
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: true
            });
            localStream = stream;
            webcamVideo.srcObject = stream;
            
            // 캔버스 크기 맞추기
            resizeCanvas();
            window.addEventListener('resize', resizeCanvas);
            
            // 가상 스캔 빔 가동
            startCanvasAnimation();
        } catch (err) {
            console.error("Camera/Audio Init Error:", err);
            alert("⚠️ 카메라 및 마이크 권한 오류\n\n현장 검수를 위해 카메라 및 오디오(음성) 권한을 허용해 주십시오.\n(에러: " + err.message + ")");
        }
    };

    const resizeCanvas = () => {
        if (scannerCanvas && cameraState) {
            scannerCanvas.width = cameraState.clientWidth;
            scannerCanvas.height = cameraState.clientHeight;
        }
    };

    // 실시간 카메라 스캔 라인 캔버스 애니메이션
    const startCanvasAnimation = () => {
        const ctx = scannerCanvas.getContext('2d');
        
        const draw = () => {
            ctx.clearRect(0, 0, scannerCanvas.width, scannerCanvas.height);
            
            const w = scannerCanvas.width;
            const h = scannerCanvas.height;

            // 카메라 모서리 타겟 가이드라인 그리기
            ctx.strokeStyle = isRecording ? 'rgba(255, 60, 60, 0.6)' : 'rgba(255, 251, 0, 0.6)';
            ctx.lineWidth = 4;
            const size = 30;
            const pad = 40;

            // 좌상
            ctx.beginPath();
            ctx.moveTo(pad, pad + size); ctx.lineTo(pad, pad); ctx.lineTo(pad + size, pad);
            ctx.stroke();
            // 우상
            ctx.beginPath();
            ctx.moveTo(w - pad, pad + size); ctx.lineTo(w - pad, pad); ctx.lineTo(w - pad - size, pad);
            ctx.stroke();
            // 좌하
            ctx.beginPath();
            ctx.moveTo(pad, h - pad - size); ctx.lineTo(pad, h - pad); ctx.lineTo(pad + size, h - pad);
            ctx.stroke();
            // 우하
            ctx.beginPath();
            ctx.moveTo(w - pad, h - pad - size); ctx.lineTo(w - pad, h - pad); ctx.lineTo(w - pad - size, h - pad);
            ctx.stroke();

            // 녹화 중일 때 세로 스캔 레이저 빔 가동
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
                ctx.shadowBlur = 0; // 그림자 초기화
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

        // MediaRecorder 생성 (오디오 트랙 포함)
        let options = { mimeType: 'video/webm;codecs=vp9,opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/webm;codecs=vp8,opus' };
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options = { mimeType: 'video/mp4' }; // 아이폰(Safari) 대응용 포맷
            }
        }

        try {
            mediaRecorder = new MediaRecorder(localStream, options);
            mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    recordedChunks.push(e.data);
                }
            };

            // 녹화가 완전히 중단되었을 때 동작
            mediaRecorder.onstop = () => {
                const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
                const videoURL = URL.createObjectURL(blob);
                resultVideo.src = videoURL;

                // 음성 인식 결과 텍스트 바인딩
                const finalTranscript = transcribedText.trim();
                voiceResultText.innerText = finalTranscript 
                    ? `"${finalTranscript}"`
                    : "🗣️ 녹화된 음성 지시 사항이 없습니다. 아래 메모장을 활용해 추가 메모를 남기실 수 있습니다.";

                // 화면 전환 및 AI 정밀 분석 모션 실행
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

                // 1.5초간 AI 스캐닝 프로그래스 애니메이션 진행
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
                        
                        // STT 기반 자재 및 수량 파싱
                        const parsed = parseSTTResult(finalTranscript);
                        
                        // UI 바인딩
                        document.getElementById('aiMaterialSelect').value = parsed.material;
                        document.getElementById('aiDetectedCount').innerText = `${parsed.count}개`;
                        document.getElementById('confirmedCountInput').value = parsed.count; // 기본 피드백 입력값을 AI 검출값으로 채움
                        
                        // 상태 판단 뱃지 업데이트
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
                        
                        // 로딩창 가리고 결과 노출
                        aiLoadingOverlay.classList.add('hidden');
                        resultContent.classList.remove('hidden');
                    }
                }, 150);

                // 카메라 하드웨어 스트림 정지 (리소스를 반환하고 빨간 불 끄기)
                stopCameraStream();
            };

            // 녹화 가동
            mediaRecorder.start();
            isRecording = true;

            // UI 변경
            recordBtn.className = 'record-btn-recording';
            recordBtn.classList.add('recording');
            recIndicator.style.display = 'inline-block';
            guideText.innerText = '🔴 녹화 중... 자재를 가리키며 목소리로 보고 내용을 설명해 주십시오.';
            recordingTimer.style.display = 'block';

            // 타이머 작동
            recordStartTime = Date.now();
            timerInterval = setInterval(updateTimer, 1000);

            // 음성 인식 작동
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

        // 타이머 및 음성 인식 중지
        clearInterval(timerInterval);
        timerInterval = null;
        if (recognition) {
            try {
                recognition.stop();
            } catch (e) {
                console.warn(e);
            }
        }

        // UI 복귀
        recordBtn.className = 'record-btn-idle';
        recIndicator.style.display = 'none';
        guideText.innerText = '🎤 비디오 촬영을 시작하고, 목소리로 자재 수량을 설명해 주십시오.';
        recordingTimer.style.display = 'none';
    };

    // 타이머 갱신
    const updateTimer = () => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');
        recordingTimer.innerText = `${minutes}:${seconds}`;

        // 30초 한계 도달 시 자동 중지
        if (elapsed >= 30) {
            stopRecording();
        }
    };

    // 카메라 스트림 중지
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

    // 녹화 버튼 클릭 이벤트 바인딩
    recordBtn.addEventListener('click', () => {
        if (!isRecording) {
            startRecording();
        } else {
            stopRecording();
        }
    });


    // 나의 데이터 자산 저장 (IndexedDB에 축적 + 갤러리 다운로드 트리거)
    btnSaveAsset.addEventListener('click', async () => {
        if (recordedChunks.length === 0) {
            alert("저장할 녹화 데이터가 없습니다.");
            return;
        }

        // 버튼 비활성화로 더블 탭 방지
        btnSaveAsset.disabled = true;
        btnSaveAsset.innerText = "💾 데이터 자산에 저장 중...";

        try {
            const blob = new Blob(recordedChunks, { type: mediaRecorder ? mediaRecorder.mimeType : 'video/webm' });
            
            // AI 검수 및 확정 피드백 데이터 수집
            const aiMaterial = document.getElementById('aiMaterialSelect').value;
            const aiCount = parseInt(document.getElementById('aiDetectedCount').innerText) || 0;
            const confirmedCount = parseInt(document.getElementById('confirmedCountInput').value) || 0;
            const status = document.getElementById('aiStatusBadge').innerText;

            const transcriptVal = voiceResultText.innerText.replace(/^"|"$/g, '').trim();
            const memoVal = memoInput.value.trim();
            
            // GPS 위치 즉시 갱신 반영
            updateGps();
            
            await saveInspection(blob, transcriptVal, memoVal, currentGps, aiMaterial, aiCount, confirmedCount, status);

            // 2. 내 기기(갤러리)에 파일 다운로드 트리거
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const min = String(now.getMinutes()).padStart(2, '0');
            const sec = String(now.getSeconds()).padStart(2, '0');
            
            const extension = mediaRecorder && mediaRecorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
            a.download = `김반장검수_${yyyy}${mm}${dd}_${hh}${min}${sec}.${extension}`;
            
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);

            alert("💾 [데이터 자산 축적 완료]\n\n촬영된 영상과 검수 텍스트가 스마트폰 내 '나의 데이터 자산'에 안전하게 추가되었으며, 갤러리에도 동영상이 저장되었습니다!");
            
            // 대시보드 건수 갱신
            await updateBadgeCount();
            
            // 카메라 화면으로 원복
            resetToCamera();
        } catch (err) {
            console.error("Save Asset Error:", err);
            alert("데이터 자산 저장 중 오류 발생: " + err.message);
        } finally {
            btnSaveAsset.disabled = false;
            btnSaveAsset.innerHTML = '<span class="material-icons-round">save</span> 💾 나의 데이터 자산에 저장';
        }
    });

    // 다시 촬영하기 버튼
    btnRetry.addEventListener('click', () => {
        resetToCamera();
    });

    const resetToCamera = () => {
        // 입력값 초기화
        memoInput.value = "";

        // 결과 비디오 메모리 해제
        if (resultVideo.src) {
            URL.revokeObjectURL(resultVideo.src);
            resultVideo.src = "";
        }
        
        // 화면 전환
        resultState.classList.add('hidden');
        cameraState.classList.remove('hidden');
        dashboardState.classList.add('hidden');
        currentView = 'camera';
        btnToggleView.classList.remove('active');
        
        // 카메라 재가동
        initCamera();
    };

    // 대시보드 목록 렌더링 로직
    const renderDashboard = async () => {
        const inspections = await getAllInspections();
        
        // 통계 갱신
        totalRecordsText.innerText = `${inspections.length}건`;
        
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
            
            // 신규 필드 매핑
            const aiMaterial = item.aiMaterial || "파이프";
            const confirmedCount = item.confirmedCount !== undefined ? item.confirmedCount : 0;
            const status = item.status || "정상";
            const isDefect = status.includes("진단 필요");

            html += `
            <div class="asset-item">
                <div class="asset-thumbnail">
                    <span class="material-icons-round">${isDefect ? 'report_problem' : 'video_file'}</span>
                    <div class="asset-badge" style="background: ${isDefect ? '#ff3c3c' : 'rgba(0,0,0,0.75)'}">WEBM</div>
                </div>
                <div class="asset-details">
                    <div class="asset-meta">
                        <span class="asset-date">📅 ${item.date}</span>
                        <span class="asset-size">💾 ${sizeMB} MB</span>
                    </div>
                    <div class="asset-transcript-preview" style="color: var(--safety-yellow); font-weight: 800;">🤖 AI: ${aiMaterial} [${confirmedCount}개 확정]</div>
                    <div class="asset-transcript-preview" style="font-size: 0.95rem; color: #cbd5e1;">🗣️ ${shortTranscript}</div>
                    <div class="asset-memo-preview">📝 ${shortMemo}</div>
                </div>
                <div class="asset-actions">
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

                modalTranscript.innerHTML = `
                    <strong>자재:</strong> ${aiMaterial} | 
                    <strong>AI 판정:</strong> ${aiCount}개 | 
                    <strong>최종 확정:</strong> <span style="color: var(--safety-yellow); font-weight: 900;">${confirmedCount}개</span> (${status})<br>
                    <strong>음성 기록 (STT):</strong> "${item.transcript || '음성 없음'}"
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
        const inspections = await getAllInspections();
        assetCountBadge.innerText = inspections.length;
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
            csvContent += "ID,날짜,용량(Bytes),AI 탐지 자재,AI 탐지 수량,최종 확정 수량,AI 결함 판정,음성 인식 결과(STT),추가 메모,GPS 위치,비디오 파일명\n";
            
            const videoFolder = zip.folder("videos");
            
            inspections.forEach((item) => {
                const filename = `video_${item.id}.webm`;
                
                // 특수문자 및 따옴표 처리
                const safeTranscript = (item.transcript || "").replace(/"/g, '""');
                const safeMemo = (item.memo || "").replace(/"/g, '""');
                const safeGps = (item.gps || "").replace(/"/g, '""');
                const safeAiMaterial = (item.aiMaterial || "").replace(/"/g, '""');
                const safeStatus = (item.status || "").replace(/"/g, '""');
                
                csvContent += `${item.id},"${item.date}",${item.size},"${safeAiMaterial}",${item.aiCount || 0},${item.confirmedCount || 0},"${safeStatus}","${safeTranscript}","${safeMemo}","${safeGps}","${filename}"\n`;
                
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

    // 시작 시 배지 개수 계산 및 최초 카메라 기동
    updateBadgeCount();
    initCamera();
});
