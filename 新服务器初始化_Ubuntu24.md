# Ubuntu 24.04 新服务器初始化与 SSH 加固

本说明适用于刚开通的 Ubuntu 24.04 云服务器。目标是：

- 不再使用 root 账号日常登录；
- 创建独立的 `serveradmin` 管理员账号；
- 使用 SSH 密钥登录；
- 确认新账号可用后，禁止 root 远程登录和 SSH 密码登录；
- 最终只向公网开放 SSH 12345 和网站 80 端口；
- 保持系统安全更新。

> 最重要的原则：在确认 `serveradmin` 可以从第二个终端正常登录之前，不要禁用 root、
> 不要关闭密码登录，也不要退出第一次 SSH 会话。

文中的 `服务器IP` 请替换为实际公网 IP。管理员名也可以修改，但后续所有命令必须保持一致。

## 一、先检查云平台安全组

在云服务器厂商控制台中设置入站规则：

| 端口 | 来源 | 用途 |
|---|---|---|
| TCP 22 | 优先限制为自己的公网 IP | 首次登录，迁移完成后删除 |
| TCP 12345 | 优先限制为自己的公网 IP | 最终 SSH 管理端口 |
| TCP 80 | 全部来源 | 网站 |

不要开放 10123 端口。Node.js 服务部署后只在服务器本机访问，公网请求由 Nginx 的 80
端口转发。

同时确认云平台提供了网页终端、VNC 或救援模式。一旦 SSH 配置错误，可通过该入口恢复。

## 二、第一次登录服务器

不同云平台的初始账号可能是 `root` 或 `ubuntu`。按厂商提供的信息选择一个：

```powershell
ssh root@服务器IP
```

或者：

```powershell
ssh ubuntu@服务器IP
```

登录后确认系统：

```bash
whoami
cat /etc/os-release
uname -a
```

`VERSION_ID` 应为 `24.04`。

## 三、更新系统并设置时区

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt autoremove --purge -y
sudo timedatectl set-timezone Asia/Shanghai
timedatectl
```

如果看到 `/var/run/reboot-required`，先记住需要重启，但等新管理员和 SSH 密钥配置完成后再重启：

```bash
test -f /var/run/reboot-required && echo "稍后需要重启"
```

## 四、创建独立管理员账号

以下示例使用 `serveradmin`：

```bash
sudo adduser serveradmin
sudo usermod -aG sudo serveradmin
id serveradmin
```

`adduser` 会要求设置密码。这个密码用于执行 `sudo`，应使用新的强密码，不要与网站教师密码相同。

## 五、在 Windows 电脑生成 SSH 密钥

回到本机 Windows PowerShell，先检查目标密钥是否已经存在：

```powershell
Test-Path $env:USERPROFILE\.ssh\physics_server_ed25519
```

如果返回 `False`，创建新的 Ed25519 密钥：

```powershell
ssh-keygen -t ed25519 -a 64 `
  -f $env:USERPROFILE\.ssh\physics_server_ed25519 `
  -C "physics-server-admin"
```

建议为私钥设置口令。生成后：

- `physics_server_ed25519` 是私钥，只保存在自己的电脑，不能上传或发给别人；
- `physics_server_ed25519.pub` 是公钥，可以放到服务器。

请把私钥另做一份离线加密备份。关闭 SSH 密码登录后，如果私钥和云平台救援入口同时丢失，
将无法通过普通 SSH 登录服务器。

上传公钥。初始账号是 root 时：

```powershell
scp $env:USERPROFILE\.ssh\physics_server_ed25519.pub `
  root@服务器IP:/tmp/serveradmin.pub
```

初始账号是 ubuntu 时：

```powershell
scp $env:USERPROFILE\.ssh\physics_server_ed25519.pub `
  ubuntu@服务器IP:/tmp/serveradmin.pub
```

## 六、把公钥安装给新管理员

回到第一次 SSH 会话，在服务器运行：

```bash
sudo install -d -m 700 -o serveradmin -g serveradmin \
  /home/serveradmin/.ssh
sudo install -m 600 -o serveradmin -g serveradmin \
  /tmp/serveradmin.pub /home/serveradmin/.ssh/authorized_keys
sudo rm -f /tmp/serveradmin.pub
sudo chmod 750 /home/serveradmin
```

检查权限：

```bash
sudo ls -ld /home/serveradmin /home/serveradmin/.ssh
sudo ls -l /home/serveradmin/.ssh/authorized_keys
```

## 七、必须在第二个终端验证新账号

不要关闭第一次 SSH 会话。另开一个 Windows PowerShell 窗口：

```powershell
ssh -i $env:USERPROFILE\.ssh\physics_server_ed25519 `
  serveradmin@服务器IP
```

登录成功后测试 sudo：

```bash
whoami
sudo -v
sudo whoami
```

最后一条应输出：

```text
root
```

只有以上步骤全部成功，才能继续修改 SSH 端口、禁用 root 和密码登录。

## 八、把 SSH 改为 12345，并禁止 root 和密码登录

先确认云平台安全组已经放行 TCP 12345。服务器如果已经启用 UFW，也必须先放行 12345：

```bash
sudo apt install -y ufw
sudo ufw limit 12345/tcp
sudo ufw status verbose
```

在仍保持连接的管理员会话中创建独立配置片段：

```bash
sudo tee /etc/ssh/sshd_config.d/00-server-hardening.conf >/dev/null <<'EOF'
Port 12345
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
DebianBanner no
EOF
```

先检查语法，成功时不会输出内容：

```bash
sudo sshd -t
```

再检查最终生效值：

```bash
sudo sshd -T | grep -E \
  'port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|maxauthtries|x11forwarding'
```

应看到：

```text
port 12345
permitrootlogin no
passwordauthentication no
kbdinteractiveauthentication no
pubkeyauthentication yes
maxauthtries 3
x11forwarding no
```

Ubuntu 24.04 默认使用 SSH socket 激活。修改端口后需要重新生成 systemd 配置并重启 socket：

```bash
sudo systemctl daemon-reload
if systemctl is-active --quiet ssh.socket; then
  sudo systemctl restart ssh.socket
else
  sudo systemctl restart ssh.service
fi
sudo ss -lntp | grep 12345
sudo systemctl status ssh.socket ssh.service --no-pager
```

再次打开第三个终端，确认仍然可以通过密钥登录：

```powershell
ssh -p 12345 -i $env:USERPROFILE\.ssh\physics_server_ed25519 `
  serveradmin@服务器IP
```

然后验证 root 登录已经被拒绝：

```powershell
ssh -p 12345 root@服务器IP
```

Ubuntu 的 root 账号是系统必需账号，不能删除。这里禁止的是“直接以 root 远程登录”；
需要管理系统时，由 `serveradmin` 使用 `sudo` 临时提升权限。

如果云平台曾为 root 设置过密码，还可锁定 root 密码：

```bash
sudo passwd -l root
```

`PermitRootLogin no` 仍然必须保留，因为锁定密码本身不会移除已经配置的 SSH 公钥。

如果初始账号是 `ubuntu`，并且确认云平台不依赖它，还可以只允许新管理员通过 SSH 登录：

```bash
echo 'AllowUsers serveradmin' | \
sudo tee -a /etc/ssh/sshd_config.d/00-server-hardening.conf
sudo sshd -t
sudo systemctl restart ssh.service
```

添加后仍应另开一个终端重新验证 `serveradmin`。如果将来新增其他 SSH 管理员，需要同时把用户名
加入 `AllowUsers`，否则新账号会被拒绝。

## 九、启用服务器防火墙

先安装并配置规则：

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit 12345/tcp
sudo ufw allow 80/tcp
sudo ufw status verbose
```

确认通过 12345 的新 SSH 会话仍然可用，再启用：

```bash
sudo ufw enable
sudo ufw status numbered
```

如果列表中仍有 22 端口规则，使用显示的规则编号删除：

```bash
sudo ufw status numbered
sudo ufw delete 规则编号
```

最后在云平台安全组中删除 TCP 22 入站规则。最终只保留 TCP 12345 和 TCP 80。不要开放
10123 端口。

## 十、启用自动安全更新

Ubuntu Server 通常已经安装并启用 `unattended-upgrades`。再次确认：

```bash
sudo apt install -y unattended-upgrades
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
sudo tee /etc/apt/apt.conf.d/52-local-reboot-policy >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF
sudo systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
systemctl status unattended-upgrades --no-pager
systemctl list-timers apt-daily.timer apt-daily-upgrade.timer --no-pager
```

这里关闭的是“无人值守自动重启”，安全更新仍会自动安装。需要重启时由管理员选择维护时间。

## 十一、2 GB 内存服务器可增加交换空间

先检查：

```bash
free -h
swapon --show
```

如果 `swapon --show` 已经显示交换空间，不要重复创建。如果完全为空，可以创建 2 GB：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
swapon --show
```

交换空间不能代替内存，但能降低安装原生 Node.js 依赖或短时内存升高时被系统直接终止的风险。

## 十二、重启并做最终检查

保持云平台网页终端可用，然后重启：

```bash
sudo reboot
```

等待约一分钟，从 Windows 重新登录：

```powershell
ssh -p 12345 -i $env:USERPROFILE\.ssh\physics_server_ed25519 `
  serveradmin@服务器IP
```

检查：

```bash
sudo ufw status verbose
sudo systemctl status ssh --no-pager
sudo systemctl status unattended-upgrades --no-pager
sudo ss -tulpn
free -h
df -h
```

完成后即可继续执行 `部署_Ubuntu24.md`。

## 十三、让以后登录更简单

在 Windows 新建或编辑：

```text
C:\Users\你的用户名\.ssh\config
```

加入：

```text
Host physics-server
    HostName 服务器IP
    User serveradmin
    Port 12345
    IdentityFile ~/.ssh/physics_server_ed25519
    IdentitiesOnly yes
```

以后可以直接使用：

```powershell
ssh physics-server
scp 文件路径 physics-server:/tmp/
```

## 十四、SSH 配置错误时如何恢复

如果新连接失败，但旧 SSH 会话还在，不要退出旧会话：

```bash
sudo rm -f /etc/ssh/sshd_config.d/00-server-hardening.conf
sudo sshd -t
sudo systemctl daemon-reload
sudo systemctl restart ssh.socket 2>/dev/null || sudo systemctl restart ssh.service
```

如果所有 SSH 会话都已断开，使用云平台网页终端、VNC 或救援模式执行同样操作。
