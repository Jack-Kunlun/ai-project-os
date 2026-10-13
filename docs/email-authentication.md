# 邮箱认证

邮箱功能通过阿里云邮件推送 DirectMail `SingleSendMail` API 发送验证码，不使用 SMTP。发信地址须完成验证，专用 AccessKey 须有 `dm:SingleSendMail` 权限。

本地 Next.js 配置使用 `AI_PROJECT_OS_EMAIL_AUTH_ENABLED=true`，以及 `AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID`、`AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET`、`AI_PROJECT_OS_ALIYUN_DM_REGION_ID`、`AI_PROJECT_OS_ALIYUN_DM_ACCOUNT_NAME`。主密钥须已存在于数据库之外。不得提交配置值或将其放入页面、日志、命令参数。

生产将四项配置保存在 GitHub `production` Environment secrets 中，由受限工作流通过 SSH stdin 写入 root 所有、0600 的 `/etc/ai-project-os/email-auth.env`。Compose 以 raw env_file 仅传入 app，避免凭据中的引号、美元符号和反斜杠被再次解释；要求 Compose 2.30 或以上。配置写入只返回固定回执，应用重建后才生效。CI 收到配置回执不等于真实邮件送达。

注册时选择邮箱方式，填写未被使用的邮箱并获取验证码；每次发送前完成图形验证。注册证明只能用于本次浏览器和对应邮箱。已有账号可在个人资料保存尚未验证的邮箱，再完成邮箱验证。启用功能后，已验证邮箱不可通过个人资料替换或清空；邮箱换绑与邮箱找回待单独实现。

设置或修改密码时，有已验证邮箱的账号须输入该邮箱收到的验证码；修改已有密码还须输入当前密码。成功后重新登录。没有邮箱的既有账号保留原有密码设置路径；已有但未验证的邮箱需先验证。关闭功能时保留原用户名/手机号登录方式。

真实收信验收使用专用测试邮箱。密码、图形验证码和邮件验证码仅由用户在应用页面输入；提供商返回成功、邮箱实际收到、页面验证成功和旧会话失效是不同的验收状态。
