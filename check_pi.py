import pexpect
import sys

def check_pi():
    password = "@123#"
    ip = "192.168.1.35"
    user = "v25"
    
    cmd = f'ssh -o StrictHostKeyChecking=no {user}@{ip} "systemctl --no-pager status v25-camera v25-lidar v25-gpio-agent"'
    print(f"Running: {cmd}")
    
    child = pexpect.spawn(cmd)
    try:
        i = child.expect(['password:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
        if i == 0:
            child.sendline(password)
            child.expect(pexpect.EOF)
            print(child.before.decode())
        elif i == 1:
            print("EOF reached unexpectedly")
            print(child.before.decode())
        else:
            print("Timeout reached")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_pi()
