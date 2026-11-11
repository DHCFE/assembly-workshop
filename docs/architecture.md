# 架构与验收

场景包是 AI 与工作台之间的约定。Blender 源工程保存可编辑的细节，配方给出构件、起点、安装顺序和手势，编译后的索引记录可逐步插值的位置和形状。WebGL 视口加载 GLB，按当前操作绘制构件。Easy 与 Medium 在浏览器组合原始步骤，存档继续使用原始步骤编号。

公开试玩通过相对路径读取同一个构建产物。进度使用浏览器存储，下载文件保存场景 ID 和步骤值。服务版和静态站共用工作台。服务版从已发布的场景版本接收存档，并在 Blender 中应用几何变化后生成工程文件。

照片服务把上传、任务和分区发布放在同一个地址。每项任务记录在本地目录。主体配方和地台并行准备。每个分区先完成 Blender 编译，再发布版本标记，浏览器收到后追加资产。中断后的项目从已完成的区域继续，已保存的配方可复用。服务支持两项同时生成与一个 Blender 导出。每个项目的进度由玩家浏览器保存。

## 验证

```sh
npm ci
npm run build
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
```

Python 集成测试使用本机的模拟视觉 API 检查读图请求、分段发布和导出。安装 Blender 后运行 `WORKSHOP_TEST_BLENDER=1 python3 -m unittest discover -s tests -p 'test_*.py'` 可启用这组测试。浏览器测试从实际页面操作零件并验证存档，执行 `npx playwright install chromium` 后运行 `npm run test:browser`。

仓库包含木作山居和螺旋山城。山城预览采用 meshoptimizer 压缩并保留零件元数据。源模型位于示例目录。重新编译示例可用 `python3 runtime/cli.py prepare <场景目录>`。要重建压缩资源，保留原始编译文件并运行 `npx gltfpack -i <原始.glb> -o <发布.glb> -c -kn -ke -km -vpf -vp 16`。
