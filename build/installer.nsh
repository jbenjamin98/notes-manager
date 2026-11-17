; Friendlier words for the installer. Included by electron-builder (nsis.include).

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
  !define MUI_WELCOMEPAGE_TITLE "Welcome, star-gazer"
  !define MUI_WELCOMEPAGE_TEXT "You are about to give your notes a night sky.$\r$\n$\r$\nNote Manager keeps your notes as plain files on this computer, links every person, company and project it finds, and shows how it all connects.$\r$\n$\r$\nNo admin rights, no account, nothing leaves your machine unless you ask it to.$\r$\n$\r$\nClick Install to light the first star."
  !define MUI_FINISHPAGE_TITLE "Lift-off complete"
  !define MUI_FINISHPAGE_TEXT "Note Manager is installed and your notes have a new home.$\r$\n$\r$\nTip: press Ctrl+Shift+Space from anywhere to capture a task without leaving what you are doing."
  !define MUI_FINISHPAGE_RUN_TEXT "Open Note Manager and meet the stars"
!macroend

!macro customInstall
  DetailPrint "Charting the night sky..."
  Sleep 250
  DetailPrint "Teaching your notes to find each other..."
  Sleep 250
  DetailPrint "Politely asking the Tuesday meeting to stay in one place..."
  Sleep 250
  DetailPrint "Lighting the first star. Welcome."
!macroend

!macro customUnInstall
  DetailPrint "Your notes stay where you put them. Only the app is leaving."
!macroend
