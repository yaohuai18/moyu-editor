/**
 * 会话失效时整页跳回登录页。
 *
 * 为什么不用 next/navigation 的 router.replace：
 * 走到这一步说明会话已经没了，我们要的是把当前页面里所有内存状态
 * （没保存的正文、AI 结果、选中的版本）**彻底丢掉**，换一个干净的登录页。
 * 软跳转会把旧状态留在内存里，登录回来还看得见，容易误判。
 *
 * 为什么要拼成绝对地址：
 * 1. 相对地址在应用挂到子路径（basePath）下时会跳错；
 * 2. eslint 的 @next/next/no-location-assign-relative-destination 也会拦。
 */
export function redirectToLogin() {
  window.location.assign(new URL("/login", window.location.origin).toString());
}
