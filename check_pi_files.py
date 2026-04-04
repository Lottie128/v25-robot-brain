import pexpect
import sys

def run_pi_cmd(cmd):
    password = "@123#"
    ip = "192.168.1.35"
    user = "v25"
    
    full_cmd = f'ssh -o StrictHostKeyChecking=no {user}@{ip} "{cmd}"'
    print(f"Running: {full_cmd}")
    
    child = pexpect.spawn(full_cmd)
    try:
        i = child.expect(['password:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
        if i == 0:
            child.sendline(password)
            child.expect(pexpect.EOF)
            return child.before.decode()
        else:
            return f"Error: {child.before.decode()}"
    except Exception as e:
        return f"Error: {e}"

if __name__ == "__main__":
    print(run_pi_cmd("ls /etc/systemd/system/v25-*"))
