/**
 * 管理任务页（实施文档 6.9）。
 *
 * 上游没有"任务列表"接口，只能按 operationId 查询单个任务（GET /operations/{operationId}），
 * 因此这里只展示本浏览器已经发起或已经知道 ID 的任务，绝不制造"所有历史任务"的假象。
 * 具体轮询、取消与结果解析全部交给 OperationTrackerPanel（页面不再另建轮询实现）。
 */

import { OperationTrackerPanel } from '@/components/OperationTrackerPanel';
import styles from './TasksPage.module.scss';

export function TasksPage() {
  return (
    <div className={styles.page}>
      <section className="keeper-card">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <span className="app-topbar__eyebrow">Tasks</span>
            <h2 className="keeper-card__title">管理任务</h2>
            <p className="keeper-card__subtitle">
              上游 Parrot 只提供单个任务的查询接口，没有全局任务列表接口。本页显示的是
              <strong>只属于当前浏览器的已知任务</strong>。
            </p>
          </div>
        </div>
        <div className="keeper-card__body">
          <div className={styles.sectionBody}>
            <div className="notice-box" role="note">
              <div className={styles.sectionBody}>
                <strong>为什么这里看不到"所有历史任务"</strong>
                <span>
                  上游接口只有 <span className="mono">GET /operations/&#123;operationId&#125;</span> 与取消接口，
                  没有"列出全部任务"的管理端点（允许清单里也没有）。因此 WebUI 只能记录本浏览器发起（或从上游响应里拿到 ID）
                  的任务，并按需查询它的真实终态；其他管理端（例如原 Telegram 管理）发起的任务不会出现在这个列表里，
                  这里也不会为了凑数去展示任何猜测出来的历史记录。
                </span>
                <span>
                  列表保存在当前页面的内存中（不写入 localStorage / sessionStorage），刷新页面即清空，切换页面不会重复创建任务。
                </span>
              </div>
            </div>

            <OperationTrackerPanel />
          </div>
        </div>
      </section>

      <section className="keeper-card">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <h3 className="keeper-card__title">任务语义与操作说明</h3>
            <p className="keeper-card__subtitle">对应实施文档 7.3 的异步 operation 规则</p>
          </div>
        </div>
        <div className="keeper-card__body">
          <ul className={styles.noteList}>
            <li>任务来自页面上的异步动作（例如刷新渠道用量、同步账号模型）；上游返回 202 只代表"已受理"，不代表已经成功。</li>
            <li>只有上游返回 <span className="mono">cancellable=true</span> 的任务才允许"申请取消"；申请取消后仍继续读取真实终态。</li>
            <li>进度为 null 时显示"无进度上报"，不会伪造百分比。</li>
            <li>整体 succeeded 仍可能包含逐来源失败，此时任务行会额外显示"部分成功"的说明与完整结果（纯文本展示）。</li>
            <li>任务查询返回 404 表示该任务记录已不可用（可能已过期或原实例重启）；此时只提示并刷新相关业务资源，绝不自动重做任务。</li>
            <li>
              读取任务状态同样是上游管理权限范围内的动作：若上游判定权限不足（CAPABILITY_DENIED）或链路中断，
              错误会直接显示在对应任务行上，而不是被吞成"没有任务"。
            </li>
            <li>本页只读取任务状态与申请取消，不会触发更新、重启原 Parrot 容器之类的操作。</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
