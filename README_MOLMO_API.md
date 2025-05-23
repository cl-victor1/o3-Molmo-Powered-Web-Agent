# Molmo API 双重实现

本扩展现在支持两种不同的 Molmo API 调用方式：

## 1. 本地 API (Local API)
- **URL**: `http://localhost:8000/molmo/point`
- **用途**: 通过 SSH 隧道连接到 Hyak Molmo 服务
- **优点**: 
  - 不需要 API 密钥
  - 速度较快
  - 适合开发和测试
- **缺点**: 需要运行本地服务器

## 2. 官方 API (Official API)  
- **URL**: `https://ai2-reviz--uber-model-v4-synthetic.modal.run/completion_stream`
- **用途**: 直接调用 AI2 的官方 Molmo API
- **优点**:
  - 不需要本地服务器
  - 稳定可靠
  - 支持流式响应
- **缺点**: 需要 API 密钥

## 如何配置

### 在扩展弹窗中配置:

1. **选择 API 类型**:
   - 在 "Molmo API Configuration" 部分
   - 从下拉菜单选择 "Local API" 或 "Official API"
   - 点击 "Save" 保存设置

2. **配置官方 API 密钥** (仅当选择 Official API 时):
   - 在 API 类型选择为 "Official API" 后，会显示密钥输入框
   - 输入你的 Molmo API 密钥
   - 点击 "Save" 保存密钥

### 在代码中配置:

```javascript
// 在 background.js 中修改这些常量:

// 选择 API 类型: 'local' 或 'official'
let MOLMO_API_TYPE = 'local';  // 改为 'official' 使用官方 API

// 设置官方 API 密钥 (仅当使用官方 API 时需要)
let MOLMO_API_KEY = "你的_API_密钥";
```

## API 响应格式差异

### 本地 API 响应格式:
```json
{
  "points": [
    {
      "point": [x, y]
    }
  ]
}
```

### 官方 API 响应格式:
流式响应，每行一个 JSON 对象:
```json
{"result": {"output": {"text": "坐标信息在文本中"}}}
```

## 实现细节

代码会自动根据 `MOLMO_API_TYPE` 选择合适的 API：

- `callMolmoAPI()` - 主路由函数，根据配置选择 API
- `callMolmoLocalAPI()` - 调用本地 API  
- `callMolmoOfficialAPI()` - 调用官方 API
- `parseCoordinatesFromText()` - 从官方 API 的文本响应中解析坐标

## 错误处理

两种 API 都实现了相同的重试机制：
- 最多重试 3 次
- 指数退避算法
- 详细的错误日志

## 切换 API 类型

你可以随时在扩展弹窗中切换 API 类型，无需重启扩展。配置会自动保存到 Chrome 存储中。 