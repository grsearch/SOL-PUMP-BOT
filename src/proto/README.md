# gRPC Proto Files

把官方 proto 文件放到这个目录:

- `laserstream.proto`  — Helius LaserStream
  - 从 https://github.com/helius-labs/laserstream-grpc 或 Helius 文档拿到
  - 不放也行: gRPC 通道会失败但其他模块仍工作 (会丢失精度,但买卖逻辑不受影响)

- `shredstream.proto`  — Shredstream
  - 从 docs.shredstream.com 拿到 (订阅时官方会提供)
  - 同上,不放也行

放好后 `npm start`,启动日志里看到 `connected to ...` 即成功。
