# config.json 분리 개발용 파일

GitHub 저장소 루트에 아래 파일을 덮어쓰기/추가하세요.

## 반드시 업로드할 파일

- config.json
- app.js
- index.html
- service-worker.js

## 역할

- config.json: Apps Script 웹앱 URL과 VIEWER_TOKEN 저장
- app.js: config.json을 읽어서 API 연결
- index.html: 개발 중 app.js 캐시를 자동 회피
- service-worker.js: 기존 PWA 캐시 삭제 및 service worker 해제

## config.json 수정 예

{
  "apiUrl": "https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxx/exec",
  "token": "my-stock-viewer-1234",
  "smallWeightThreshold": 0.01
}

주의: apiUrl은 /exec까지만 넣습니다.
?action=dashboard&token=... 은 app.js가 자동으로 붙입니다.
