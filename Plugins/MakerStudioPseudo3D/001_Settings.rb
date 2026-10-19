# encoding: UTF-8

module MakerStudioPseudo3D
  # 修改本文件后，完全退出并重新启动游戏即可生效；不再要求先重新编译插件。

  # 启动游戏时是否默认启用伪 3D 摄像机。false 表示默认使用普通平面地图。
  CAMERA_ENABLED = true

  # 旧版焦距校准所用的地平线高度比例。
  # 仅当 CAMERA_FOCAL_LENGTH_RATIO 设为 0 时生效，用于兼容旧工程参数。
  CAMERA_HORIZON_RATIO = 0.08

  # 焦距相对屏幕高度的倍率，直接控制近大远小的透视强度。
  # 数值越大越接近平行投影、近景 OBJ 越不易拉伸；2.3523 对应 Godot 的 24° 垂直 FOV。
  # 设为 0 时恢复由 CAMERA_HORIZON_RATIO 和 CAMERA_TARGET_RATIO 推算焦距。
  CAMERA_FOCAL_LENGTH_RATIO = 1.3523

  # 烘焙相机的透视强度倍率。距离由地图相机焦距换算，而不是各自的包围
  # 球半径 —— 后者让每个模型在自己的“专属焦距”下成像，书架、围栏、
  # 高楼的顶部前倾度因此互不一致。
  # 1.0 = 与地面完全同一套透视（几何正确，各模型严格一致）。数值越大
  # 前倾越明显，但高模型的眼点会被 radius * 1.8 下限挡住而无法继续
  # 靠近，一致性随之下降；建议保持 1.0～1.4。
  MODEL_PERSPECTIVE_EXAGGERATION = 1.0

  # 烘焙画面相对网格投影包围框的留白倍率。FOV 由 8 个包围盒角点精确
  # 拟合，这里只留抗锯齿边缘的余量。
  MODEL_BAKE_FRAME_MARGIN = 1.04

  # 地图摄像机横向移动转换为 Model3D 镜头平移的比例。离轴部分只平移
  # 镜头和目标点；模型的连续观察方位由实例 rotation 转换到相机方位，
  # 不修改模型 rotation_*。
  MODEL_VIEW_PARALLAX = 0.72
  # 镜头平移量以“相对固定拍摄距离的夹角”限制。提高上限后，模型
  # 接近屏幕边缘时可以露出足够的侧面。
  MODEL_VIEW_PARALLAX_MAX_DEGREES = 26.0

  # Model3D 观察方位与离轴镜头平移的缓存粒度。
  # Keep successive observation-angle bakes within a quarter degree so the
  # rendered bitmap does not visibly step between discrete viewpoints.
  MODEL_VIEW_BUCKET_DEGREES = 0.25

  # 同一个 OBJ 位图两次 GPU 烘焙之间至少间隔的帧数。四角和地基锚点仍
  # 每帧更新；这里只限制昂贵的 Model3D.render。
  # 可见 OBJ 各自更新，不按放置顺序争抢重绘额度；镜头静止时复用位图。
  # Model3D reuses the target bitmap/FBO; permit a new bake on each frame when
  # the quantized observation angle changes.
  MODEL_RENDER_MIN_INTERVAL = 1

  # OBJ 相对地面摄像机的独立俯角修正（度），不改变地面、角色或模型地基位置。
  # 负数可削弱模型看起来向镜头前倾的感觉；建议只在 -5.0～5.0 之间微调。
  MODEL_PITCH_OFFSET_DEGREES = -2.0

  # 四边形底边现在直接对齐烘焙里的地面（包围盒底面投影），因此默认不需
  # 要额外偏移。模型整体偏高或偏低时微调这个值。
  MODEL_GROUND_OFFSET_PIXELS = 0.0

  # Model3D 烘焙位图的超采样倍率。最终仍由 Sprite corners 映射到
  # 屏幕尺寸；2.0 可避免近景小模型把 32～54px 原图直接放大。
  GPU_MODEL_SUPERSAMPLE = 2.0

  # OBJ authored front correction (degrees). The actual Model3D azimuth is
  # calculated continuously from the model-to-map-camera vector. Use this only
  # to correct an asset whose exported +Z front does not match the map axes.
  MODEL_CAMERA_AZIMUTH_DEGREES = 0.0

  # 摄像机对准的地面位置，占屏幕高度的比例。
  # 0.545 对应 Godot 参考画面中的主角脚底位置，使透视中性点与主角对齐。
  # 增大后近景区域变多，减小后远景区域变多，但也会让中性点离开主角。
  CAMERA_TARGET_RATIO = 0.345

  # 摄像机从水平线向下俯视的实际角度（度），有效范围为 1.0～89.0。
  # 数值越小越贴近地平线；数值越大越接近正俯视。37.72 对应 Godot 参考相机的实际俯角。
  CAMERA_PITCH_DEGREES = 37.72

  # 地面投影一次处理的屏幕行数。1 最清晰；2 较均衡；3～4 更省性能。
  CAMERA_SCANLINE_HEIGHT = 2

  # 最远绘制距离（图块数）。40 格覆盖当前相机画面顶部，仍保留有限视距。
  # 地面按需分块缓存；屏幕外 OBJ 在创建渲染资源前裁剪。
  CAMERA_FAR_TILES = 40

  # 伪 3D 模式是否显示底层全景图。关闭蓝色天空背景；普通 2D 模式仍保留地图设置。
  CAMERA_SHOW_PANORAMA = false

  # 远景 OBJ 的更新频率。近景仍然每帧重投影；超过该距离后，模型
  # Bitmap 在若干帧内复用，只更新 Sprite 的屏幕位置。数值越大越省 CPU，
  # 但相机滚动时远景几何更新会更滞后。
  PSEUDO3D_LOD_NEAR_TILES = 8.0
  # Keep the native bitmap for the whole visible far range. At this distance
  # the projected model is small enough that a few frames of anchor-only
  # motion are not perceptible, while avoiding repeated CPU rasterization.
  PSEUDO3D_LOD_FAR_TILES = CAMERA_FAR_TILES.to_f
  PSEUDO3D_LOD_UPDATE_INTERVAL = 4
  # Re-rasterize an OBJ only after its projected ground anchor moved by this
  # many screen pixels. Smaller camera steps use anchor-only Sprite movement.
  PSEUDO3D_MODEL_REDRAW_DISTANCE_PIXELS = 2.5
  # Register one nearby OBJ (vertices + textures) ahead of visibility each
  # frame. This moves the one-time native upload off the exact reveal frame.
  PSEUDO3D_PREWARM_RADIUS_PIXELS = 768.0
  # Terrain height metadata is uploaded as one bitmap after it is assembled.
  # Process only a few cells per frame so entering a new atlas cannot stall.
  PSEUDO3D_TERRAIN_DATA_CELLS_PER_FRAME = 8

  # 地面分块缓存数量。每个分块约占 256 KB；降低可省内存，提高可减少移动时重复生成。
  CAMERA_CHUNK_CACHE = 64

  # 伪 3D 模式下是否继续绘制旧版动态阴影。
  # 旧阴影不支持透视投影，而且事件数和光源数较多时开销会成倍增长，建议保持 false。
  CAMERA_DYNAMIC_SHADOWS = false

  # 是否启用伪 3D 定向光和贴地投影。关闭后不再生成下方的环境暗度与方向阴影。
  PSEUDO3D_LIGHTING_ENABLED = true

  # 全局环境暗度，0 表示不压暗，负数会让地面、角色和模型整体更有明暗层次。
  PSEUDO3D_AMBIENT_TONE = -16

  # 光线投影方向（度）。0 向右，90 向下，180 向左，270 向上。
  # 以纵深方向为主，保留少量横向分量，避免正墙上的云影大幅斜切。
  PSEUDO3D_SHADOW_ANGLE_DEGREES = 100.0

  # 阴影相对物体基础尺寸的长度倍率；数值越大，影子沿光线方向延伸越远。
  PSEUDO3D_SHADOW_LENGTH = 0.75

  # 地形、墙面和模型共用的云影投射斜率（水平距离 / 高度）。
  # 1.0 对应 45 度太阳高度角；过小会把云影沿墙面拉成长条。
  # 高处沿投影方向的反方向取样；在同一高度的接缝处取样一致。
  PSEUDO3D_CLOUD_HEIGHT_PARALLAX = 0.75

  # 是否柔化模型表面的云影边缘（对角四点取样的轻微模糊）。地面云影
  # 保持硬边；开启后墙面/屋顶的云影边缘会有 0.5 混合的柔和过渡，
  # 立体感更强，但与地面云影在墙脚接缝处的边缘粗细不再完全一致。
  PSEUDO3D_OBJECT_FOG_SOFTEN_EDGES = false


  # 伪 3D 贴地阴影不透明度，范围为 0～255。
  PSEUDO3D_SHADOW_OPACITY = 72

  # 立牌、OBJ 模型及摆放场景数据的保存目录。通常不需要修改。
  DATA_DIR = "Data/MakerStudioPseudo3D"

  # OBJ 栅格化结果的磁盘缓存目录。删除其中内容后会在下次运行时重新生成。
  CACHE_DIR = "Data/MakerStudioPseudo3D/Cache"

  # 地图图块边长（像素），必须与 Pokemon Essentials 的图块尺寸保持一致。
  TILE_SIZE = 32

  # 立牌和 OBJ 的空间索引分桶尺寸（像素）。增大可减少桶数量，但会扩大每次查询范围。
  BUCKET_SIZE = 256

  # 屏幕外仍保留渲染的边距（像素），用于避免大型物件刚进入画面时突然出现。
  CULL_MARGIN = 160

  # 单个 OBJ 栅格化位图允许的最大边长（像素），用于限制大型模型的内存占用。
  MAX_BITMAP = 768

  # 资源没有提供像素高度时采用的默认立牌/模型高度（像素）。
  DEFAULT_HEIGHT = 96

  # OBJ GPU 渲染时的环境光强度，通常使用 0.0～1.0；数值越大暗面越亮。
  AMBIENT_LIGHT = 0.38

  # OBJ 地面阴影的不透明度，范围为 0～255；0 为不可见，255 为完全不透明。
  SHADOW_ALPHA = 56
end
