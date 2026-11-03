/**
 * 群聊「成员排队」的启动判据（纯函数，不依赖 React / 宿主）。
 *
 * ## 为什么单独抽出来
 *
 * 群聊里成员必须一个说完另一个才开口。第一版写成了固定错峰（300 / 1000 / 1700ms），
 * 而一轮回复要几十秒——第二个成员开口时第一个的正文还在流式生成，它既看不到前文，
 * 「多视角评审」就退化成三个人各自回答同一段背景。
 *
 * 改成「等上一位收口」之后立刻踩到第二个坑：**第三位会插队**。它第一次检查时，
 * 第二位还排在第一位后面、压根没启动，用「不在运行中」判断「已经说完」就会让
 * 第二位和第三位同时开口。这个 bug 在界面上表现为「两个人几乎同时开始打字」，
 * 没有任何报错——只能靠判据本身可测来防。
 *
 * 所以判据在这里是一张**真值表**，而不是散在回调里的几个 if。
 */

/** 排队时的观察结果。 */
export interface RoomQueueInput {
  /** 上一位是否已经真正启动过（对应 `ScheduledReply.started`）。 */
  previousStarted: boolean
  /** 上一位是否被停止键取消。 */
  previousCancelled: boolean
  /**
   * 上一位此刻是否还有活着的轮次。
   *
   * 只在 `previousStarted` 为 true 时有意义：没启动过的人当然「不在运行中」，
   * 但那不代表它说完了。
   */
  previousRunning: boolean
  /** 从开始排队到现在的毫秒数。 */
  elapsedMs: number
  /** 最多等多久（超时兜底）。 */
  timeoutMs: number
}

export type RoomQueueDecision = 'wait' | 'start'

/**
 * 这一位现在该不该开口。四种情况：
 *
 *  1. 上一位**没启动过、也没被取消**：它自己还排在更前面的人后面。
 *     **必须继续等**——把它当成「已经说完」就是第三位插队的那个 bug。
 *     只有超时才放行（某一位卡住不能把整条队伍冻住）。
 *  2. 上一位**没启动过、但已被取消**：它永远不会启动了，直接放行，
 *     不必陪它等到超时。
 *  3. 上一位**启动过、还在跑**：等它；超时放行。
 *  4. 上一位**启动过、已经不在跑**：轮到这一位。
 */
export function shouldStartNext(input: RoomQueueInput): RoomQueueDecision {
  const timedOut = input.elapsedMs >= input.timeoutMs
  if (!input.previousStarted) {
    // 上一位被取消且从未启动：它永远不会启动了，不必陪它等到超时
    if (input.previousCancelled) return 'start'
    return timedOut ? 'start' : 'wait'
  }
  if (input.previousRunning) return timedOut ? 'start' : 'wait'
  return 'start'
}
