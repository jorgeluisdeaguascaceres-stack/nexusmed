#!/usr/bin/env python3
"""NexusMed Conciliación v4.0 — COOSALUD + FOMAG

Uso local:
    python run.py
    # o
    flask run
"""

import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
