import sys
with open("backend/server.py", "rb") as f:
    data = bytearray(f.read())

# All \x3f bytes preceded by a UTF-8 continuation byte (0x80-0xBF)
# are corrupted \x82 bytes
count = 0
for i in range(1, len(data)):
    if data[i] == 0x3f and 0x80 <= data[i-1] <= 0xBF:
        data[i] = 0x82
        count += 1

print(f"Fixed {count} corrupted bytes")

# Now check: are there any remaining issues where 。) should be 。") ?
# After fixing the corruption, we have \xe3\x80\x82\x29 but should be
# \xe3\x80\x82\x22\x29 (。")
target = b"\xe3\x80\x82\x29"
replacement = b"\xe3\x80\x82\x22\x29"
cnt = data.count(target)
print(f"Found {cnt} cases of 。) missing closing quote")
if cnt > 0:
    data = data.replace(target, replacement)
    print("Fixed missing quotes")

with open("backend/server.py", "wb") as f:
    f.write(data)
    print("File saved")
