# usage: pty-answer.py <answer> <cmd...>; runs cmd on a real pty, types answer at the prompt, prints output + "EXIT <code>"
import os, pty, sys, select
ans, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out, sent = b'', False
while True:
    r, _, _ = select.select([fd], [], [], 15)
    if not r: break
    try: chunk = os.read(fd, 4096)
    except OSError: break
    if not chunk: break
    out += chunk
    if not sent and b'[y/N]' in out:
        os.write(fd, (ans + '\n').encode()); sent = True
_, st = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors='replace').replace('\r\n', '\n'))
sys.stdout.write('\nEXIT %d\n' % os.waitstatus_to_exitcode(st))
