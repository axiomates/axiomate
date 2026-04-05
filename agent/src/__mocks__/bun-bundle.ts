// Mock for bun:bundle feature flags
// 在测试中所有 feature() 返回 false（关闭所有实验特性）
export function feature(_name: string): boolean {
  return false
}
