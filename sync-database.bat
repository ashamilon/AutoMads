@echo off
cd /d "%~dp0"
echo Syncing your database tables to PostgreSQL...
call npx prisma db push
echo.
if errorlevel 1 (
  echo Something went wrong. Make sure PostgreSQL is running and DATABASE_URL in .env is correct.
  echo Then run this file again.
) else (
  echo Done! Your database is ready.
)
pause
