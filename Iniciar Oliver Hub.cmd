@echo off
title Oliver Hub (modo de teste)
cd /d "%~dp0"
where node >nul 2>nul || (echo Instale o Node.js 20 ou mais novo: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias pela primeira vez... & call npm install)
node scripts\iniciar-dev.mjs
pause
