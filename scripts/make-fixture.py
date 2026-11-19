"""Create a synthetic Messages database. Never reads the user's Messages."""
import sqlite3
from pathlib import Path

target = Path(__file__).resolve().parents[1] / 'macos/Sources/PassedAround/Resources/demo-chat.db'
target.parent.mkdir(parents=True, exist_ok=True)
if target.exists():
    target.unlink()
db = sqlite3.connect(target)
db.executescript('''
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER, associated_message_type INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
INSERT INTO chat VALUES (1, 'The sample listening club'), (2, 'A different sample chat');
INSERT INTO chat_handle_join VALUES (1,1),(1,2),(1,3),(2,4),(2,5);
''')
messages = [
    (1, 1, 'SYNTHETIC MESSAGE — this sentence must never be uploaded. https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=tracking'),
    (2, 1, 'One for the queue: https://open.spotify.com/track/0ofHAoxe9vBkTCp2UQIavz'),
    (3, 1, 'An independent release: https://jonathanmann.bandcamp.com/track/i-just-want-to-be-an-old-man'),
    (4, 1, 'Same song on video https://youtu.be/dQw4w9WgXcQ?si=tracking'),
    (5, 1, 'Here is that first link again https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'),
    (6, 1, 'An album https://open.spotify.com/album/1bt6q2SruMsBtcerNVtpZB'),
    (7, 1, 'Ordinary private conversation, not music.'),
    (8, 1, 'A non-music link https://example.com/private?token=must-not-leave'),
    (9, 2, 'This other conversation must not be scanned https://open.spotify.com/track/69kOkLUCkxIZYexIgSG8rq'),
]
for row, chat, body in messages:
    db.execute('INSERT INTO message (ROWID,text,date) VALUES (?,?,?)', (row, body, (816_000_000 + row * 300) * 1_000_000_000))
    db.execute('INSERT INTO chat_message_join VALUES (?,?)', (chat, row))
db.commit()
db.close()
print('Created synthetic demo fixture.')
