# 小小物理站：Ubuntu 24.04 部署说明

本方案面向 Ubuntu 24.04、2 核 2 GB 服务器。第一版使用：

- Nginx 对外监听 80 端口；
- Node.js 24 LTS 在本机 `127.0.0.1:10123` 运行；
- systemd 保持服务常驻并在异常后自动重启；
- SQLite 数据保存在 `/var/lib/physics-practice`，与程序更新分离；
- 教师上传的练习包和图片保存在 `/var/lib/physics-practice/exercise-content`；
- 每天自动生成一致性数据库备份，默认保留 14 天。

部署文件不会保存教师明文密码。首次安装时会在服务器终端中隐藏输入。

## 零、新服务器先完成初始化

如果服务器刚开通，请先完整执行 [新服务器初始化_Ubuntu24.md](./新服务器初始化_Ubuntu24.md)：

1. 安装系统更新；
2. 创建独立的 `serveradmin` 管理员；
3. 配置 SSH 密钥并在第二个终端验证；
4. 将 SSH 改到 12345，验证后关闭 22；
5. 禁止 root 远程登录和 SSH 密码登录；
6. 配置 UFW、防自动重启的安全更新和可选交换空间；
7. 重启后确认仍能通过 `serveradmin` 登录。

完成这些步骤后再继续部署网站。

## 一、在本机生成发布包

在 Windows PowerShell 中进入 `PAGE` 文件夹，然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\package-release.ps1
```

将生成：

```text
release\physics-practice-ubuntu24.tar.gz
```

发布包不会包含 `node_modules`、日志、本地数据库或本地 `.env`。

## 二、上传到服务器

把下面的 `服务器IP` 替换为实际公网 IP：

```powershell
scp -P 12345 -i $env:USERPROFILE\.ssh\physics_server_ed25519 `
  .\release\physics-practice-ubuntu24.tar.gz serveradmin@服务器IP:/tmp/
```

登录服务器：

```powershell
ssh -p 12345 -i $env:USERPROFILE\.ssh\physics_server_ed25519 serveradmin@服务器IP
```

## 三、首次安装

在 Ubuntu 服务器执行：

```bash
rm -rf /tmp/physics-practice-release
mkdir -p /tmp/physics-practice-release
tar -xzf /tmp/physics-practice-ubuntu24.tar.gz -C /tmp/physics-practice-release
sudo bash /tmp/physics-practice-release/deploy/install-ubuntu-24.sh
```

安装程序会：

1. 确认系统为 Ubuntu 24.04；
2. 安装 Node.js 24 LTS、pnpm、Nginx、SQLite 和必要编译工具；
3. 创建权限受限的 `physics-practice` 系统账号；
4. 安装网站到 `/opt/physics-practice`；
5. 提示输入教师用户名和密码；
6. 启用网站服务、Nginx 和每日数据库备份；
7. 运行本机健康检查。

完成后，通过以下地址访问：

```text
http://服务器IP:80/
```

脚本会准备 UFW 的 SSH 和 HTTP 规则，但不会在尚未启用时强行开启防火墙。确认当前 SSH
连接正常后，可执行：

```bash
sudo ufw status
sudo ufw enable
```

如果云服务器厂商另有“安全组”，还需要在控制台放行：

- TCP 12345：SSH；
- TCP 80：网站访问。

不需要对公网开放 10123 端口。

## 四、部署后检查

```bash
curl http://127.0.0.1:10123/api/health
sudo systemctl status physics-practice --no-pager
sudo systemctl status nginx --no-pager
sudo systemctl list-timers physics-practice-backup.timer --no-pager
```

查看网站日志：

```bash
sudo journalctl -u physics-practice -n 100 --no-pager
sudo journalctl -u physics-practice -f
```

## 五、更新网站

在本机重新生成并上传发布包，在服务器解压到新的临时目录：

```bash
rm -rf /tmp/physics-practice-update
mkdir -p /tmp/physics-practice-update
tar -xzf /tmp/physics-practice-ubuntu24.tar.gz -C /tmp/physics-practice-update
sudo bash /tmp/physics-practice-update/deploy/update-ubuntu-24.sh
```

更新前会先备份 SQLite 数据库、教师上传的练习内容和上一版程序。更新不会覆盖学生账号、答案、分数或评语；
如果启动检查失败，脚本会恢复上一版程序。

## 六、备份与恢复

自动备份目录：

```text
/var/lib/physics-practice/backups
```

每天会生成两类文件：

- `practice-时间.sqlite.gz`：账号、题目、作答、批改和统计数据库；
- `exercise-content-时间.tar.gz`：教师上传的原始练习包和题目图片。

立即手动备份：

```bash
sudo systemctl start physics-practice-backup.service
sudo journalctl -u physics-practice-backup -n 30 --no-pager
```

恢复某个备份前，先停止服务：

```bash
sudo systemctl stop physics-practice
sudo cp /var/lib/physics-practice/practice.db \
  /var/lib/physics-practice/practice.db.before-restore
sudo gzip -dc /var/lib/physics-practice/backups/备份文件.sqlite.gz \
  | sudo tee /var/lib/physics-practice/practice.db >/dev/null
sudo chown physics-practice:physics-practice \
  /var/lib/physics-practice/practice.db
sudo chmod 600 /var/lib/physics-practice/practice.db
sudo systemctl start physics-practice
```

如果练习使用了上传图片，还应恢复与数据库备份时间相近的上传内容包：

```bash
sudo systemctl stop physics-practice
sudo rm -rf /var/lib/physics-practice/exercise-content
sudo tar -xzf \
  /var/lib/physics-practice/backups/exercise-content-备份时间.tar.gz \
  -C /var/lib/physics-practice
sudo chown -R physics-practice:physics-practice \
  /var/lib/physics-practice/exercise-content
sudo systemctl start physics-practice
```

## 七、配置文件

正式配置位于：

```text
/etc/physics-practice/physics-practice.env
```

修改后重启：

```bash
sudo systemctl restart physics-practice
```

不要把教师密码写入该文件。教师账号由数据库保存，密码只保存为哈希。

## 八、新增教师账号

通过 SSH 登录服务器后运行：

```bash
sudo bash /opt/physics-practice/deploy/create-teacher.sh
```

按提示输入新教师用户名、密码并再次确认。密码输入时不会显示，也不会出现在命令历史中。
用户名不能与已有学生或教师重复，密码至少 8 位。创建成功后无需重启网站，新教师可以立即登录。

教师账号拥有相同权限，包括学生账号管理、批改、成绩发布、题库上传和永久删除。只应为可信任的
教师创建账号，并为每位教师分别创建账号，不要多人共用一个密码。

## 九、以后配置域名和 HTTPS

当前部署按 `http://IP/` 测试，因此 `COOKIE_SECURE=false`。配置域名和有效 HTTPS 证书后，
把配置改为：

```text
COOKIE_SECURE=true
```

然后执行：

```bash
sudo systemctl restart physics-practice
```

在启用 HTTPS 前，只应使用专门的测试密码，不要使用邮箱、微信或其他系统的相同密码。

## 十、常用维护命令

```bash
sudo systemctl restart physics-practice
sudo systemctl stop physics-practice
sudo systemctl start physics-practice
sudo systemctl status physics-practice --no-pager
sudo nginx -t
sudo systemctl reload nginx
df -h
free -h
```

## 十一、目录说明

| 路径 | 用途 |
|---|---|
| `/opt/physics-practice` | 网站程序，只读运行 |
| `/var/lib/physics-practice/practice.db` | 正式 SQLite 数据库 |
| `/var/lib/physics-practice/backups` | 每日数据库备份 |
| `/var/lib/physics-practice/exercise-content` | 教师上传的练习包和图片 |
| `/etc/physics-practice/physics-practice.env` | 运行配置 |
| `/etc/systemd/system/physics-practice.service` | 常驻服务 |
| `/etc/nginx/sites-available/physics-practice` | Nginx 配置 |
