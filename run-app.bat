@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo [도면자동화 v0.8.0] 실행 준비 중...

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js를 찾을 수 없습니다. Node.js 20.19 이상을 설치하세요.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [오류] Python을 찾을 수 없습니다. Python 3을 설치하고 PATH에 추가하세요.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Node 패키지를 처음 설치합니다...
  call npm install
  if errorlevel 1 goto :failed
)

python -c "import fitz" >nul 2>nul
if errorlevel 1 (
  echo Python 패키지를 처음 설치합니다...
  python -m pip install -r requirements.txt
  if errorlevel 1 goto :failed
)

echo 웹 파일을 빌드합니다...
call npm run build
if errorlevel 1 goto :failed

echo.
echo 서버 주소: http://127.0.0.1:8000
echo 종료하려면 이 창에서 Ctrl+C를 누르세요.
echo.
python server.py
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo [오류] 실행 중 문제가 발생했습니다. 위 메시지를 확인하세요.
pause
exit /b 1
