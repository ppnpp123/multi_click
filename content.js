/* content.js - Chrome Extension
 * 功能：按下 Z 键后进入框选模式，用户可以在页面上拖动矩形选择区域，松开鼠标后
 *   自动检测所有被选中（与选择框相交）的元素并依次触发 click 事件。
 */

// =============================================
// 全局状态管理 - 追踪用户交互和选中元素的状态变量
// =============================================
// 框选相关变量
let isSelecting = false;
let selectBox = null;
let startX = 0;
let startY = 0;
// Z键状态
let zPressed = false;
let lastZPressTime = 0; // 记录上次按Z键的时间
const DOUBLE_PRESS_DELAY = 300; // 双击判定延迟（毫秒）
// 保护层，防止页面捕获到鼠标事件
let overlay = null;
// 存储被选中的元素
let selectedElements = [];

// =============================================
// 检查元素是否对用户有意义
// =============================================
function isSignificantElement(el) {
  // 忽略宽度或高度太小的元素
  if (el.offsetWidth < 5 || el.offsetHeight < 5) {
    return false;
  }

  // 检查元素是否是文本节点或包含文本内容
  const hasText = el.textContent && el.textContent.trim().length > 0;

  // 检查重要标签类型
  const importantTags = ['a', 'button', 'input', 'select', 'textarea', 'img', 'video', 'audio',
                         'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'tr',
                         'label', 'option', 'canvas', 'svg', 'iframe', 'dd', 'dt']; // 添加 dd 和 dt

  if (importantTags.includes(el.tagName.toLowerCase())) {
    return true;
  }

  // 检查角色属性
  const importantRoles = ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'tabpanel',
                          'listitem', 'option', 'heading', 'img', 'banner', 'navigation'];
  if (el.hasAttribute('role') && importantRoles.includes(el.getAttribute('role'))) {
    return true;
  }

  // 检查元素是否可点击
  if (el.hasAttribute('onclick') ||
      el.hasAttribute('href') ||
      window.getComputedStyle(el).cursor === 'pointer') {
    return true;
  }

  // 检查是否有意义的样式特征(如边框、背景色等)
  const style = window.getComputedStyle(el);
  if (style.border !== 'none' ||
      style.borderRadius !== '0px' ||
      style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
    // 检查元素大小，太大的元素可能是容器
    const isReasonableSize = el.offsetWidth < 500 && el.offsetHeight < 500;
    if (isReasonableSize) {
      return true;
    }
  }

  // 如果元素有有意义的文本内容且不是容器元素
  if (hasText && el.children.length === 0) {
    return true;
  }

  // 更严格地检查大型容器
  if (el.tagName.toLowerCase() === 'div' || el.tagName.toLowerCase() === 'section') {
    // 如果是容器元素，且太大或包含太多子元素，则认为不重要
    if (el.offsetWidth > 400 || el.offsetHeight > 400 || el.children.length > 5) {
      return false;
    }
  }

  return false;
}

// =============================================
// 检查元素是否隐藏或禁用
// =============================================
function isElementHiddenOrDisabled(el) {
  const style = window.getComputedStyle(el);

  // 检查元素是否可见
  if (style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      el.offsetWidth === 0 ||
      el.offsetHeight === 0) {
    return true;
  }

  return false;
}

// =============================================
// 计算两个矩形的重叠百分比
// =============================================
function getOverlapPercentage(rect1, rect2) {
  // 计算重叠区域
  const overlapLeft = Math.max(rect1.left, rect2.left);
  const overlapRight = Math.min(rect1.right, rect2.right);
  const overlapTop = Math.max(rect1.top, rect2.top);
  const overlapBottom = Math.min(rect1.bottom, rect2.bottom);

  // 如果没有重叠区域，返回0
  if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) {
    return 0;
  }

  // 计算重叠面积
  const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);

  // 计算元素面积
  const rect1Area = rect1.width * rect1.height;

  // 防止除以零
  if (rect1Area === 0) return 0;

  // 返回重叠百分比
  return overlapArea / rect1Area;
}

// =============================================
// 框选功能 - 实现矩形区域内元素的批量选择
// =============================================
// 创建选择框
function startBoxSelection() {
  // 设置状态为正在选择
  isSelecting = true;

  // 创建选择框元素
  selectBox = document.createElement('div');
  selectBox.id = 'batch-selector-box';
  selectBox.style.position = 'absolute';
  selectBox.style.border = '1px dashed blue';
  selectBox.style.backgroundColor = 'rgba(0, 123, 255, 0.1)';
  selectBox.style.zIndex = '9999';
  // 计算相对于 overlay（fixed 定位）的坐标，去掉页面滚动偏移
  selectBox.style.left = (startX - window.pageXOffset) + 'px';
  selectBox.style.top = (startY - window.pageYOffset) + 'px';
  selectBox.style.width = '0';
  selectBox.style.height = '0';
  selectBox.style.pointerEvents = 'none'; // 防止框选择框本身干扰选择

  // 添加到文档
  document.body.appendChild(selectBox);
}



// 取消框选择
function cancelBoxSelection() {
  isSelecting = false;

  // 移除选择框
  if (selectBox && selectBox.parentNode) {
    selectBox.parentNode.removeChild(selectBox);
  }

  selectBox = null;
}

// =============================================
// 元素查找与筛选系统 - 实现智能元素识别和选择
// =============================================
// 查找框内的所有元素
function findElementsInBox(boxRect) {
  // 所有可能的目标元素
  const potentialElements = document.querySelectorAll('*');
  const elementsInBox = [];
  const preFilteredElements = []; // 先收集所有满足基本条件的元素

  // 第一遍：收集所有框内且有意义的元素
  potentialElements.forEach(el => {
    // 跳过隐藏或无法交互的元素
    if (isElementHiddenOrDisabled(el)) {
      return;
    }

    // 跳过扩展自身的UI元素
    if (el.closest('.batch-selector-ui') ||
        el.id === 'batch-selector-notification' ||
        el.id === 'batch-selector-info' ||
        el.id === 'batch-selector-prompt' ||
        el.id === 'batch-selector-global-msg' ||
        el.id === 'batch-selector-box' ||
        el.classList.contains('batch-selector-ui')) {
      return;
    }

    // 获取元素的边界框并调整为绝对位置
    const elRect = el.getBoundingClientRect();
    const adjustedElRect = {
      left: elRect.left + window.pageXOffset,
      top: elRect.top + window.pageYOffset,
      right: elRect.right + window.pageXOffset,
      bottom: elRect.bottom + window.pageYOffset,
      width: elRect.width,
      height: elRect.height
    };

    // 检查元素是否在框内
    // 我们考虑元素有一定比例在框内就算选中
    const overlap = getOverlapPercentage(adjustedElRect, boxRect);

    if (overlap > 0.5) { // 提高阈值到50%以上的重叠算作选中
      if (isSignificantElement(el)) {
        preFilteredElements.push({
          element: el,
          depth: getElementDepth(el)
        });
      }
    }
  });

  // 按深度排序所有预筛选的元素（从浅到深）
  preFilteredElements.sort((a, b) => a.depth - b.depth);

  // 创建一个函数来检查两个元素是否存在嵌套关系
  const isNested = (parent, child) => {
    return parent.element.contains(child.element);
  };

  // 第二遍：过滤掉嵌套的元素，只保留最浅层级
  for (let i = 0; i < preFilteredElements.length; i++) {
    const current = preFilteredElements[i];
    let isContainedBySelected = false;

    // 检查当前元素是否被已选中的更浅层级元素包含
    for (const selected of elementsInBox) {
      if (selected.contains(current.element)) {
        isContainedBySelected = true;
        break;
      }
    }

    // 如果不被任何已选元素包含，才添加
    if (!isContainedBySelected) {
      elementsInBox.push(current.element);
    }
  }

  return elementsInBox;
}

// 获取元素在DOM树中的深度
function getElementDepth(el) {
  let depth = 0;
  let current = el;

  while (current && current !== document.documentElement) {
    depth++;
    current = current.parentElement;
  }

  return depth;
}

// =============================================
// 对元素执行点击
// =============================================
function clickElements(elements) {
  // 采用分段点击，确保每个元素都有机会触发
  elements.forEach((el, i) => {
    setTimeout(() => {
      // 确保元素获得焦点，部分交互需要焦点
      if (typeof el.focus === 'function') {
        el.focus();
      }
      // 直接触发元素的 click 方法，不再使用坐标事件
      if (typeof el.click === 'function') {
        el.click();
      }
    }, i * 100); // 100ms 间隔，保证前一次点击完成后再进行下一次
  });
}

// 清除上一次框选后留下的高亮或选中样式
function clearPreviousSelection() {
  // 移除所有带有蓝色实线轮廓的元素（与本插件的选中高亮一致）
  const highlighted = document.querySelectorAll('[style*="outline: 2px solid blue"]');
  highlighted.forEach(el => {
    el.style.outline = '';
  });

  // 移除可能残留的自定义 UI 样式（防止重复创建）
  const uiElems = document.querySelectorAll('.batch-selector-ui');
  uiElems.forEach(el => {
    // 如果 UI 元素本身带有 outline，也一并清除
    if (el.style && el.style.outline) {
      el.style.outline = '';
    }
  });
}

// 清除所有选中状态，包括移除高亮和清空选中元素数组
function clearAllSelections() {
  // 移除所有已选元素的高亮样式
  selectedElements.forEach(el => {
    el.style.outline = '';
  });
  
  // 清空已选元素数组
  selectedElements = [];
  
  // 清除页面上可能存在的其他选择状态
  clearPreviousSelection();
}

// =============================================
// 创建覆盖层和选择框
// =============================================
function createOverlay() {
  overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    zIndex: 2147483649, // 高 z-index，确保在页面最上层
    cursor: 'crosshair',
    backgroundColor: 'rgba(0,0,0,0.02)', // 轻度遮罩，便于观察
    userSelect: 'none',
    pointerEvents: 'auto', // 确保能捕获鼠标事件
  });
  document.body.appendChild(overlay);

  selectBox = document.createElement('div');
  Object.assign(selectBox.style, {
    position: 'absolute',
    border: '1px dashed blue', // 与 TreeClip 一致的蓝色虚线边框
    backgroundColor: 'rgba(0, 123, 255, 0.1)', // 与 TreeClip 一致的淡蓝背景
    display: 'none', // 初始隐藏，随后在 onMouseDown 中显示
    pointerEvents: 'none',
    zIndex: 2147483650,
  });
  overlay.appendChild(selectBox);
}

// 移除覆盖层
function removeOverlay() {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
  overlay = null;
  selectBox = null;
}

// =============================================
// 鼠标事件处理
// =============================================
// 鼠标按下，记录起点并开始拖动
function onMouseDown(e) {
  // 记录起点的页面坐标（包含滚动偏移）用于计算选择区域
  startX = e.clientX + window.pageXOffset;
  startY = e.clientY + window.pageYOffset;

  // 显示选择框并初始化大小（相对于视口）
  selectBox.style.display = 'block';
  Object.assign(selectBox.style, {
    left: `${e.clientX}px`,
    top: `${e.clientY}px`,
    width: '0px',
    height: '0px',
  });
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseup', onMouseUp);
  e.preventDefault();
}

function onMouseMove(e) {
  // 当前鼠标位置的视口坐标
  const curX = e.clientX;
  const curY = e.clientY;

  // 计算选择框位置（视口坐标）
  const left = Math.min(startX - window.pageXOffset, curX);  // 将startX转换为视口坐标
  const top = Math.min(startY - window.pageYOffset, curY);   // 将startY转换为视口坐标
  const width = Math.abs(curX - (startX - window.pageXOffset));  // 使用视口坐标计算宽度
  const height = Math.abs(curY - (startY - window.pageYOffset)); // 使用视口坐标计算高度

  Object.assign(selectBox.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
  // 始终显示选择框
  selectBox.style.display = 'block';
}

function onMouseUp(e) {
  // 隐藏选择框并复位
  selectBox.style.display = 'none';
  selectBox.style.width = '0px';
  selectBox.style.height = '0px';
  const endX = e.clientX + window.pageXOffset;
  const endY = e.clientY + window.pageYOffset;
  const rect = {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    right: Math.max(startX, endX),
    bottom: Math.max(startY, endY),
  };

  // 取得所有在框内的元素
  const targets = findElementsInBox(rect);
  // 先清理覆盖层，避免遮挡点击
  overlay.removeEventListener('mousedown', onMouseDown);
  overlay.removeEventListener('mousemove', onMouseMove);
  overlay.removeEventListener('mouseup', onMouseUp);
  removeOverlay();
  // 重置状态以防止残留
  isSelecting = false;
 startX = 0;
  startY = 0;

  // 执行批量点击，使用短延时防止页面跳转中断
  clickElements(targets);
  
  // 添加框内元素到选中列表（累加选择，不清除当前选择）
  targets.forEach(el => {
    // 如果元素未被选中，添加它
    if (!selectedElements.includes(el)) {
      el.style.outline = '2px solid blue';
      selectedElements.push(el);
    }
  });

  // 更新UI
  updateNotification(selectedElements.length);

  // 更新剪贴板
  updateClipboard();
}

// =============================================
// 键盘事件处理
// =============================================
// 键盘监听：按下 Z 开始框选或取消框选
document.addEventListener('keydown', e => {
  // 检测是否按下Z键
  if (e.key.toLowerCase() === 'z' && !e.repeat) {
    const currentTime = Date.now();
    
    // 检查是否为双击（在规定时间内第二次按下Z键）
    if (currentTime - lastZPressTime < DOUBLE_PRESS_DELAY) {
      // 双击Z键：取消所有框选
      clearAllSelections(); // 清除所有选中状态和高亮
      selectedElements = []; // 清空已选元素数组
      updateNotification(0); // 更新通知
      lastZPressTime = 0; // 重置时间
      return;
    }
    
    // 记录Z键按下状态和时间
    zPressed = true;
    lastZPressTime = currentTime;
    
    // 当 Z 键按下且未进入选择状态时，开始框选
    if (!isSelecting) {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }
      // 在开始新的框选前，先清除上一次框选留下的高亮或选中状态
      clearPreviousSelection();

      isSelecting = true;
      createOverlay();
      overlay.addEventListener('mousedown', onMouseDown);
    }
  }
});

// 键盘监听：Z 键释放，结束或取消框选
document.addEventListener('keyup', e => {
  if (e.key.toLowerCase() === 'z') {
    zPressed = false;
    if (isSelecting) {
      // 取消当前选择并清理
      overlay.removeEventListener('mousedown', onMouseDown);
      overlay.removeEventListener('mousemove', onMouseMove);
      overlay.removeEventListener('mouseup', onMouseUp);
      removeOverlay();
      isSelecting = false;
    }
  }
});

// 若用户在未完成选择时按下 Esc，则取消操作
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isSelecting) {
    overlay.removeEventListener('mousedown', onMouseDown);
    overlay.removeEventListener('mousemove', onMouseMove);
    overlay.removeEventListener('mouseup', onMouseUp);
    removeOverlay();
    isSelecting = false;
  }
});

// 更新通知显示
function updateNotification(count) {
  // 移除旧的通知
  const oldNotification = document.getElementById('batch-selector-notification');
  if (oldNotification) {
    oldNotification.remove();
  }

  // 创建新的通知
  const notification = document.createElement('div');
  notification.id = 'batch-selector-notification';
  notification.textContent = `已选中 ${count} 个元素`;
  Object.assign(notification.style, {
    position: 'fixed',
    top: '10px',
    right: '10px',
    padding: '10px 15px',
    backgroundColor: '#07cba',
    color: 'white',
    borderRadius: '4px',
    fontSize: '14px',
    zIndex: 2147483651,
    fontFamily: 'Arial, sans-serif'
  });

  document.body.appendChild(notification);

  // 3秒后自动移除通知
  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 3000);
}

// 更新剪贴板内容
function updateClipboard() {
  if (selectedElements.length === 0) return;

  // 提取选中元素的文本内容
  let content = '';
  selectedElements.forEach((el, index) => {
    if (el.textContent) {
      content += el.textContent.trim() + '\n';
    } else if (el.href) {
      content += el.href + '\n';
    } else if (el.src) {
      content += el.src + '\n';
    }
  });

  // 复制到剪贴板
  navigator.clipboard.writeText(content).catch(err => {
    console.error('无法复制到剪贴板: ', err);
  });
}

// 添加CSS样式
const style = document.createElement('style');
style.textContent = `
  .batch-selector-shift-pressed {
    cursor: crosshair !important;
  }
  .batch-selector-shift-pressed a,
  .batch-selector-shift-pressed button,
  .batch-selector-shift-pressed input,
  .batch-selector-shift-pressed [role="button"],
  .batch-selector-shift-pressed [onclick] {
    pointer-events: none;
  }
  .batch-selector-prevent-events {
    pointer-events: none !important;
  }
  .batch-selector-ui {
    pointer-events: auto !important;
    user-select: none !important;
    -webkit-user-select: none !important;
    -moz-user-select: none !important;
    -ms-user-select: none !important;
  }
  .batch-selector-ui * {
    pointer-events: auto !important;
    user-select: none !important;
    -webkit-user-select: none !important;
    -moz-user-select: none !important;
    -ms-user-select: none !important;
  }
`;
document.head.appendChild(style);
