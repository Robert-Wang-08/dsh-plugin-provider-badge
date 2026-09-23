/**
 * dsh-plugin-provider-badge — node 半（宿主侧）。
 *
 * 纯载体占位：本插件的全部能力在浏览器端（client.js 经
 * conversation.input.right 席位渲染徽标），host 半只作为 roster 行被扫描
 * 挂载，注册不了任何服务、不碰 settings、不介入模型请求。
 */
export const name = 'provider-badge'

export function apply(ctx) {
  ctx.logger?.info?.('[dsh-plugin-provider-badge] host half mounted (client-driven)')
}
