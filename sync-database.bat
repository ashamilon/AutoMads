@echo off
cd /d "%~dp0"
echo Syncing your database tables to Supabase...
call npx prisma db push
echo.
if errorlevel 1 (
  echo Something went wrong. Open CONNECTION-SUPABASE.txt in this folder and follow the steps.
  echo Then run this file again.
) else (
  echo Done! Your database is ready.
)
pause
