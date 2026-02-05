@echo off
:: Przejdź do folderu, w którym znajduje się ten plik (ważne dla bazy danych!)
cd /d "%~dp0"

:: Wyświetl komunikat
echo Uruchamianie Dart Counter...
echo Nie zamykaj tego okna, dopoki grasz!

:: Otwórz przeglądarkę domyślną na odpowiednim porcie (zakładam port 3000)
:: Jeśli Twój serwer używa innego portu (np. 8080), zmień liczbę poniżej
start http://localhost:3100

:: Uruchom serwer Node.js
node server.js

:: Jeśli serwer się wyłączy (np. błąd), zatrzymaj okno, żebyś widział co się stało
pause