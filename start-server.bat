@echo off
rem 行政手続等の棚卸調査ダッシュボード ローカルサーバ
rem このファイルをダブルクリックし、表示された URL をブラウザで開いてください。
cd /d "%~dp0docs"
echo.
echo   ダッシュボードを起動します。ブラウザで次のURLを開いてください:
echo.
echo       http://localhost:8000/
echo.
echo   終了するにはこのウィンドウで Ctrl + C を押してください。
echo.
where py >nul 2>nul && (py -m http.server 8000 & goto :eof)
where python >nul 2>nul && (python -m http.server 8000 & goto :eof)
echo Python が見つかりませんでした。Python をインストールしてください。
pause
