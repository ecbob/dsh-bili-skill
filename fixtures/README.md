# fixtures —— 解码基准

这三张 8x8 的 JPEG **不是我自己生成的**，是 Windows 的 System.Drawing（独立的 baseline 编码器，标准 Annex K 码表，DHT 长度 31/181）写出来的：

| 文件 | 内容 | 期望（亮度通道） |
|---|---|---|
| `ref-flat.jpg` | 整块常量 200 | 每个像素 200 |
| `ref-hgrad.jpg` | 水平梯度 | `x*32` |
| `ref-vgrad.jpg` | 垂直梯度 | `y*32` |

自检第 17 组拿它们盯 `jpgcrop.js` 的解码：常量块必须解成常量（早先我把 IDCT 的空间/频率下标写反，DC-only 的块被解成了 200→142 的渐变，这三张 fixture 一跑就现形）。
生成方式（一次性）：`System.Drawing.Bitmap` 画 8x8 → `Save(..., ImageFormat.Jpeg)`。不进运行时逻辑，只当测试参照。
