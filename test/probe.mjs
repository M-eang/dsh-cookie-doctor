/** 手动探针：在当前进程里跑一次清理，看库是否可写。 */
import { run } from '../lib/clean.js'

const result = run({ silent: false })
console.log(JSON.stringify(result, null, 2))
