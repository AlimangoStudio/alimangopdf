-- AlimangoPDF: click to choose PDFs, or drop PDFs on the app.
-- Each filled form is fitted (row boxes merged, text wrapped and shrunk to fit) and the
-- "<name> - PRINT.pdf" result opens in Google Chrome, ready to print.
-- build.sh replaces __NODE__ with the node found on this Mac.

on run
	activate
	set theFiles to choose file with prompt "Choose the filled PDF to fit and print:" of type {"com.adobe.pdf"} with multiple selections allowed
	processFiles(theFiles)
end run

on open theFiles
	processFiles(theFiles)
end open

on processFiles(theFiles)
	set made to {}
	set errs to ""
	repeat with f in theFiles
		set p to POSIX path of f
		try
			set outLog to do shell script "__NODE__ " & quoted form of ((POSIX path of (path to me)) & "Contents/Resources/engine/make-flexible.cjs") & " " & quoted form of p & " 2>&1"
			set outPath to paragraph -1 of outLog
			if outPath starts with "saved: " then set end of made to (text 8 thru -1 of outPath)
		on error e
			set errs to errs & "Could not convert " & p & ":" & return & e & return & return
		end try
	end repeat
	repeat with m in made
		do shell script "open -a 'Google Chrome' " & quoted form of (m as text)
	end repeat
	if errs is not "" then display dialog errs buttons {"OK"} default button 1 with title "AlimangoPDF" with icon caution
end processFiles
