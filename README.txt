RealTimeChat: chat-controls layout fix

Upload the CONTENTS of this public folder into the existing GitHub repository's public/ folder, replacing matching files.
Files: index.html, style.css, app.js, manifest.json, service-worker.js.
Do not put these files in the repository root and do not upload the server separately from this patch.

The layout is updated to use fixed grid rows for chat header, filters, scrollable message history, and composer; the chat history is the only section that should scroll. Asset and service-worker cache versions were bumped.

This patch was checked for JavaScript syntax; it has not been deployed to or tested against the live Render app.
