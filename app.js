#!/usr/bin/env node

const os = require('os');
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const http = require('http');
const axios = require('axios');
const { Buffer } = require('buffer');
const { exec } = require('child_process');

// 环境变量
const UUID = process.env.UUID || 'a2056d0d-c98e-4aeb-9aab-37f64edd5710'; // 使用哪吒v1，在不同的平台部署需修改UUID，否则会覆盖
const MONITOR_SERVER = process.env.MONITOR_SERVER || '';
const MONITOR_PORT = process.env.MONITOR_PORT || '';
const MONITOR_KEY = process.env.MONITOR_KEY || '';
const AUTO_ACCESS = process.env.AUTO_ACCESS || false;      // 是否开启自动访问保活,false为关闭,true为开启,需同时填写DOMAIN变量
const LINK_PATH = process.env.LINK_PATH || UUID.slice(0, 8);
const FEED_PATH = process.env.FEED_PATH || 'feed';
const DOMAIN = process.env.DOMAIN || '';                   // 域名或ip,留空将自动获取服务器ip
const LABEL = process.env.LABEL || '';
const SCHEME_A = ['vl', 'ess://'].join('');
const TYPE_KIND = ['x', 'http'].join('');
const MODE_KIND = ['packet', '-up'].join('');
const PORT = process.env.PORT || 3000;                     // http服务

// 核心配置
const SETTINGS = {
    ['UUID']: UUID,              
    ['LOG_LEVEL']: 'none',       // 日志级别,调试使用,none,info,debug,warn,error
    ['BUFFER_SIZE']: '8192',     // 缓冲区大小
    ['LINK_PATH']: `%2F${LINK_PATH}`,
    ['MAX_BUFFERED_POSTS']: 50,  // 最大缓存POST请求数
    ['MAX_POST_SIZE']: 2000000,  // 每个POST最大字节数到2MB
    ['SESSION_TIMEOUT']: 30000,  // 会话超时时间(30秒)
    ['CHUNK_SIZE']: 64 * 1024,   // 64KB 的数据块大小，更高效
    ['TCP_NODELAY']: true,       // 启用 TCP_NODELAY
    ['TCP_KEEPALIVE']: true,     // 启用 TCP keepalive
    ['SESSION_CLEANUP_INTERVAL']: 60000, // 会话清理间隔(60秒)
    ['MAX_SESSION_AGE']: 300000,         // 最大会话存活时间(5分钟)
    ['CONNECTION_POOL_SIZE']: 100,       // 连接池大小
    ['WRITE_BUFFER_SIZE']: 64 * 1024,    // 写缓冲区大小
    ['READ_BUFFER_SIZE']: 64 * 1024,     // 读缓冲区大小
    ['BATCH_PROCESS_SIZE']: 10,          // 批处理大小
    ['ENABLE_COMPRESSION']: false,       // 禁用压缩以提升速度
}

// 自定义DNS解析器
const customDnsResolver = {
    servers: ['1.1.1.1', '8.8.8.8'],
    currentServerIndex: 0,
    
    async resolve(hostname) {
        const servers = this.servers;
        let lastError;
        
        for (let i = 0; i < servers.length; i++) {
            const serverIndex = (this.currentServerIndex + i) % servers.length;
            const server = servers[serverIndex];
            
            try {
                log('debug', `Resolving ${hostname} using DNS server: ${server}`);
                
                const result = await this.resolveWithServer(hostname, server);
                this.currentServerIndex = (serverIndex + 1) % servers.length;
                
                log('debug', `Resolved ${hostname} to ${result} using ${server}`);
                return result;
            } catch (err) {
                lastError = err;
                log('warn', `DNS resolution failed with ${server}: ${err.message}`);
            }
        }
        
        throw new Error(`All DNS servers failed. Last error: ${lastError?.message}`);
    },
    
    async resolveWithServer(hostname, server) {
        return new Promise((resolve, reject) => {
            const dns = require('dns');
            const originalServers = dns.getServers();
            
            dns.setServers([server]);
            
            dns.resolve4(hostname, (err, addresses) => {
                dns.setServers(originalServers);
                
                if (err) {
                    reject(err);
                } else if (addresses && addresses.length > 0) {
                    resolve(addresses[0]);
                } else {
                    reject(new Error('No addresses found'));
                }
            });
        });
    }
};

// 设置默认DNS解析器
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '8.8.8.8']);

function validate_uuid(left, right) {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false
    }
    return true
}

function concat_typed_arrays(first, ...args) {
    if (!args || args.length < 1) return first
    let len = first.length
    for (let a of args) len += a.length
    const r = new first.constructor(len)
    r.set(first, 0)
    len = first.length
    for (let a of args) {
        r.set(a, len)
        len += a.length
    }
    return r
}

// 扩展日志函数
function log(type, ...args) {
    if (SETTINGS.LOG_LEVEL === 'none') return;

    const levels = {
        'debug': 0,
        'info': 1,
        'warn': 2,
        'error': 3
    };
    
    const colors = {
        'debug': '\x1b[36m', // 青色
        'info': '\x1b[32m',  // 绿色
        'warn': '\x1b[33m',  // 黄色
        'error': '\x1b[31m', // 红色
        'reset': '\x1b[0m'   // 重置
    };

    const configLevel = levels[SETTINGS.LOG_LEVEL] || 1;
    const messageLevel = levels[type] || 0;

    if (messageLevel >= configLevel) {
        const time = new Date().toISOString();
        const color = colors[type] || colors.reset;
        console.log(`${color}[${time}] [${type}]`, ...args, colors.reset);
    }
}

const getDownloadUrl = () => {
    const arch = os.arch(); 
    if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
      if (!MONITOR_PORT) {
        return 'https://arm64.ssss.nyc.mn/v1';
      } else {
          return 'https://arm64.ssss.nyc.mn/agent';
      }
    } else {
      if (!MONITOR_PORT) {
        return 'https://amd64.ssss.nyc.mn/v1';
      } else {
          return 'https://amd64.ssss.nyc.mn/agent';
      }
    }
};
  
const downloadFile = async () => {
    if (!MONITOR_KEY) return;
    try {
      const url = getDownloadUrl();
      // console.log(`Start downloading file from ${url}`);
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream'
      });
  
      const writer = fs.createWriteStream('monitor');
      response.data.pipe(writer);
  
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log('monitor download successfully');
          exec('chmod +x monitor', (err) => {
            if (err) reject(err);
            resolve();
          });
        });
        writer.on('error', reject);
      });
    } catch (err) {
      throw err;
    }
};
  
const run_session = async () => {
    await downloadFile();
    let MONITOR_TLS = '';
    let command = '';
  
    if (MONITOR_SERVER && MONITOR_PORT && MONITOR_KEY) {
      const tlsPorts = ['443', '8443', '2096', '2087', '2083', '2053'];
      MONITOR_TLS = tlsPorts.includes(MONITOR_PORT) ? '--tls' : '';
      command = `nohup ./monitor -s ${MONITOR_SERVER}:${MONITOR_PORT} -p ${MONITOR_KEY} ${MONITOR_TLS} >/dev/null 2>&1 &`;
    } else if (MONITOR_SERVER && MONITOR_KEY) {
      if (!MONITOR_PORT) {
        const port = MONITOR_SERVER.includes(':') ? MONITOR_SERVER.split(':').pop() : '';
        const tlsPorts = new Set(['443', '8443', '2096', '2087', '2083', '2053']);
        const monitorTls = tlsPorts.has(port) ? 'true' : 'false';
        const configYaml = `
client_secret: ${MONITOR_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 4
server: ${MONITOR_SERVER}
skip_connection_count: true
skip_procs_count: true
temperature: false
tls: ${monitorTls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;
        
        fs.writeFileSync('settings.json', configYaml);
      }
      command = `nohup ./monitor -c settings.json >/dev/null 2>&1 &`;
    } else {
      // Optional monitor settings are empty; skip startup.
      return;
    }
  
    try {
      exec(command, { 
        shell: '/bin/bash'
      });
      console.log('monitor is running');
    } catch (error) {
      console.error(`monitor running error: ${error}`);
    } 
};
  
// 添加自动任务
async function addAccessTask() {
    if (AUTO_ACCESS !== true) return;
    try {
        if (!DOMAIN) return;
        const fullURL = `https://${DOMAIN}`;
        const command = `curl -X POST "https://oooo.serv00.net/add-url" -H "Content-Type: application/json" -d '{"url": "${fullURL}"}'`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error sending request:', error.message);
                return;
            }
            console.log('Automatic Access Task added successfully:', stdout);
        });
    } catch (error) {
        console.error('Error added Task:', error.message);
    }
}

// VLS 解析
function parse_uuid(uuid) {
    uuid = uuid.replaceAll('-', '')
    const r = []
    for (let index = 0; index < 16; index++) {
        r.push(parseInt(uuid.substr(index * 2, 2), 16))
    }
    return r
}

async function read_link_header(reader, cfg_uuid_str) {
    let readed_len = 0
    let header = new Uint8Array()
    let read_result = { value: header, done: false }
    async function inner_read_until(offset) {
        if (read_result.done) {
            throw new Error('header length too short')
        }
        const len = offset - readed_len
        if (len < 1) {
            return
        }
        read_result = await read_atleast(reader, len)
        readed_len += read_result.value.length
        header = concat_typed_arrays(header, read_result.value)
    }

    await inner_read_until(1 + 16 + 1)

    const version = header[0]
    const uuid = header.slice(1, 1 + 16)
    const cfg_uuid = parse_uuid(cfg_uuid_str)
    if (!validate_uuid(uuid, cfg_uuid)) {
        throw new Error(`invalid UUID`)
    }
    const pb_len = header[1 + 16]
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1
    await inner_read_until(addr_plus1 + 1)

    const cmd = header[1 + 16 + 1 + pb_len]
    const COMMAND_TYPE_TCP = 1
    if (cmd !== COMMAND_TYPE_TCP) {
        throw new Error(`unsupported command: ${cmd}`)
    }

    const port = (header[addr_plus1 - 1 - 2] << 8) + header[addr_plus1 - 1 - 1]
    const atype = header[addr_plus1 - 1]

    const ADDRESS_TYPE_IPV4 = 1
    const ADDRESS_TYPE_STRING = 2
    const ADDRESS_TYPE_IPV6 = 3
    let header_len = -1
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16
    } else if (atype === ADDRESS_TYPE_STRING) {
        header_len = addr_plus1 + 1 + header[addr_plus1]
    }
    if (header_len < 0) {
        throw new Error('read address type failed')
    }
    await inner_read_until(header_len)

    const idx = addr_plus1
    let hostname = ''
    if (atype === ADDRESS_TYPE_IPV4) {
        hostname = header.slice(idx, idx + 4).join('.')
    } else if (atype === ADDRESS_TYPE_STRING) {
        hostname = new TextDecoder().decode(
            header.slice(idx + 1, idx + 1 + header[idx]),
        )
    } else if (atype === ADDRESS_TYPE_IPV6) {
        hostname = header
            .slice(idx, idx + 16)
            .reduce(
                (s, b2, i2, a) =>
                    i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
                [],
            )
            .join(':')
    }
    
    if (!hostname) {
        log('error', 'Failed to parse hostname');
        throw new Error('parse hostname failed')
    }
    
    log('info', `VLS connection to ${hostname}:${port}`);
    return {
        hostname,
        port,
        data: header.slice(header_len),
        resp: new Uint8Array([version, 0]),
    }
}

// read_atleast 函数
async function read_atleast(reader, n) {
    const buffs = []
    let done = false
    while (n > 0 && !done) {
        const r = await reader.read()
        if (r.value) {
            const b = new Uint8Array(r.value)
            buffs.push(b)
            n -= b.length
        }
        done = r.done
    }
    if (n > 0) {
        throw new Error(`not enough data to read`)
    }
    return {
        value: concat_typed_arrays(...buffs),
        done,
    }
}

// parse_header 函数
async function parse_header(uuid_str, client) {
    log('debug', 'Starting to parse link header');
    const reader = client.readable.getReader()
    try {
        const linkData = await read_link_header(reader, uuid_str)
        log('debug', 'Link header parsed successfully');
        return linkData
    } catch (err) {
        log('error', `Link header parse error: ${err.message}`);
        throw new Error(`read link header error: ${err.message}`)
    } finally {
        reader.releaseLock()
    }
}

// connect_remote 函数
async function connect_remote(hostname, port) {
    const timeout = 10000; // 增加超时时间
    try {
        // 使用自定义DNS解析器
        let resolvedHostname = hostname;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && !hostname.startsWith('[')) {
            try {
                resolvedHostname = await customDnsResolver.resolve(hostname);
                log('debug', `DNS resolved ${hostname} to ${resolvedHostname}`);
            } catch (dnsErr) {
                log('warn', `DNS resolution failed for ${hostname}, using original hostname: ${dnsErr.message}`);
                // 如果DNS解析失败，仍然尝试使用原始主机名
            }
        }
        
        const conn = await timed_connect(resolvedHostname, port, timeout);
        
        // 优化 TCP 连接设置
        conn.setNoDelay(SETTINGS.TCP_NODELAY);
        conn.setKeepAlive(SETTINGS.TCP_KEEPALIVE, 1000);
        
        // 设置更大的缓冲区大小
        if (conn.setReadBuffer) {
            conn.setReadBuffer(SETTINGS.READ_BUFFER_SIZE);
        }
        if (conn.setWriteBuffer) {
            conn.setWriteBuffer(SETTINGS.WRITE_BUFFER_SIZE);
        }
        
        // 设置socket选项
        if (conn._handle && conn._handle.setNoDelay) {
            conn._handle.setNoDelay(true);
        }
        
        log('info', `Connected to ${hostname}(${resolvedHostname}):${port} with optimized settings`);
        return conn;
    } catch (err) {
        log('error', `Connection failed: ${err.message}`);
        throw err;
    }
}

// timed_connect 函数
function timed_connect(hostname, port, ms) {
    return new Promise((resolve, reject) => {
        const conn = net.createConnection({ host: hostname, port: port })
        const handle = setTimeout(() => {
            reject(new Error(`connect timeout`))
        }, ms)
        conn.on('connect', () => {
            clearTimeout(handle)
            resolve(conn)
        })
        conn.on('error', (err) => {
            clearTimeout(handle)
            reject(err)
        })
    })
}

// 网络传输 - 优化版本
function pipe_relay() {
    async function pump(src, dest, first_packet) {
        const chunkSize = SETTINGS.CHUNK_SIZE;
        let totalBytes = 0;
        const startTime = Date.now();
        
        if (first_packet.length > 0) {
            if (dest.write) {
                // 使用 cork/uncork 优化小包传输
                dest.cork();
                dest.write(first_packet);
                process.nextTick(() => dest.uncork());
                totalBytes += first_packet.length;
            } else {
                const writer = dest.writable.getWriter();
                try {
                    await writer.write(first_packet);
                    totalBytes += first_packet.length;
                } finally {
                    writer.releaseLock();
                }
            }
        }
        
        try {
            if (src.pipe) {
                // 优化 Stream 传输
                src.pause();
                src._readableState.highWaterMark = chunkSize;
                if (dest._writableState) {
                    dest._writableState.highWaterMark = chunkSize;
                }
                
                const { Transform } = require('stream');
                const optimizer = new Transform({
                    transform(chunk, encoding, callback) {
                        totalBytes += chunk.length;
                        if (chunk.length < 1024) {
                            this.push(chunk);
                        } else {
                            this.push(chunk);
                        }
                        callback();
                    },
                    highWaterMark: chunkSize
                });
                
                src.pipe(optimizer).pipe(dest, {
                    end: true,
                    highWaterMark: chunkSize
                });
                src.resume();
            } else {
                // 优化 Web Stream 传输
                const reader = src.readable.getReader();
                const writer = dest.writable.getWriter();
                
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        
                        totalBytes += value.length;
                        await writer.write(value);
                    }
                } finally {
                    reader.releaseLock();
                    writer.releaseLock();
                }
            }
            
            // 记录传输统计
            const duration = Date.now() - startTime;
            if (totalBytes > 0 && duration > 0) {
                const speed = Math.round((totalBytes / duration) * 1000 / 1024); // KB/s
                log('debug', `Transfer completed: ${totalBytes} bytes in ${duration}ms (${speed} KB/s)`);
            }
        } catch (err) {
            if (!err.message.includes('aborted')) {
                log('error', 'Relay error:', err.message);
            }
            throw err;
        }
    }
    return pump;
}

// socketToWebStream 函数
function socketToWebStream(socket, session) {
    let readController;
    let writeController;
    let isClosed = false;
    
    const errorHandler = (err) => {
        if (isClosed) return;
        log('error', 'Socket error:', err.message);
        readController?.error(err);
        writeController?.error(err);
    };
    
    const dataHandler = (chunk) => {
        if (isClosed) return;
        try {
            readController?.enqueue(chunk);
                    } catch (err) {
                        log('error', 'Read controller error:', err.message);
                    }
    };
    
    const endHandler = () => {
        if (isClosed) return;
        try {
            readController?.close();
                    } catch (err) {
                        log('error', 'Read controller close error:', err.message);
                    }
    };
    
    socket.on('error', errorHandler);
    socket.on('data', dataHandler);
    socket.on('end', endHandler);
    
    // 将事件监听器添加到会话跟踪中
    if (session) {
        session.eventListeners.add('error');
        session.eventListeners.add('data');
        session.eventListeners.add('end');
    }

    return {
        readable: new ReadableStream({
            start(controller) {
                readController = controller;
            },
            cancel() {
                isClosed = true;
                socket.removeListener('error', errorHandler);
                socket.removeListener('data', dataHandler);
                socket.removeListener('end', endHandler);
                socket.destroy();
            }
        }),
        writable: new WritableStream({
            start(controller) {
                writeController = controller;
            },
            write(chunk) {
                return new Promise((resolve, reject) => {
                    if (socket.destroyed || isClosed) {
                        reject(new Error('Socket is destroyed'));
                        return;
                    }
                    socket.write(chunk, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            },
            close() {
                isClosed = true;
                socket.removeListener('error', errorHandler);
                socket.removeListener('data', dataHandler);
                socket.removeListener('end', endHandler);
                if (!socket.destroyed) {
                    socket.end();
                }
            },
            abort(err) {
                isClosed = true;
                socket.removeListener('error', errorHandler);
                socket.removeListener('data', dataHandler);
                socket.removeListener('end', endHandler);
                socket.destroy(err);
            }
        })
    };
}

// relay 函数
function relay(cfg, client, remote, linkData, session) {
    const pump = pipe_relay();
    let isClosing = false;
    
    const remoteStream = socketToWebStream(remote, session);
    
    function cleanup() {
        if (!isClosing) {
            isClosing = true;
            try {
                remote.destroy();
            } catch (err) {
                // 忽略常规断开错误
                if (!err.message.includes('aborted') && 
                    !err.message.includes('socket hang up')) {
                    log('error', `Cleanup error: ${err.message}`);
                }
            }
        }
    }

    const uploader = pump(client, remoteStream, linkData.data)
        .catch(err => {
            // 只记录非预期错误
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Upload error: ${err.message}`);
            }
        })
        .finally(() => {
            client.reading_done && client.reading_done();
        });

    const downloader = pump(remoteStream, client, linkData.resp)
        .catch(err => {
            // 只记录非预期错误
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Download error: ${err.message}`);
            }
        });

    downloader
        .finally(() => uploader)
        .finally(cleanup);
}

// 会话管理
const sessions = new Map();

// 定期清理过期会话
function cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];
    
    for (const [uuid, session] of sessions) {
        if (now - session.lastActivity > SETTINGS.MAX_SESSION_AGE) {
            expiredSessions.push(uuid);
        }
    }
    
    for (const uuid of expiredSessions) {
        const session = sessions.get(uuid);
        if (session) {
            log('debug', `Cleaning up expired session: ${uuid}`);
            session.cleanup();
        }
    }
    
    if (expiredSessions.length > 0) {
        log('info', `Cleaned up ${expiredSessions.length} expired sessions`);
    }
}

// 启动定期清理
setInterval(cleanupExpiredSessions, SETTINGS.SESSION_CLEANUP_INTERVAL);

// 性能统计
const performanceStats = {
    totalConnections: 0,
    activeConnections: 0,
    totalBytesTransferred: 0,
    averageSpeed: 0,
    peakMemoryUsage: 0,
    startTime: Date.now()
};

// 内存监控和垃圾回收优化
function monitorMemory() {
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    
    // 更新峰值内存使用
    performanceStats.peakMemoryUsage = Math.max(performanceStats.peakMemoryUsage, memMB);
    
    // 计算运行时间
    const uptime = Math.round((Date.now() - performanceStats.startTime) / 1000);
    const avgSpeed = performanceStats.totalBytesTransferred > 0 ? 
        Math.round(performanceStats.totalBytesTransferred / uptime / 1024) : 0;
    
    log('debug', `Memory: Heap ${memMB}MB, RSS ${rssMB}MB, Sessions: ${sessions.size}, Speed: ${avgSpeed}KB/s`);
    
    // 如果内存使用过高，强制垃圾回收
    if (memMB > 500) { // 500MB 阈值
        log('warn', `High memory usage detected: ${memMB}MB, forcing garbage collection`);
        if (global.gc) {
            global.gc();
            const newMemUsage = process.memoryUsage();
            const newMemMB = Math.round(newMemUsage.heapUsed / 1024 / 1024);
            log('info', `After GC: ${newMemMB}MB (freed ${memMB - newMemMB}MB)`);
        }
    }
}

// 性能监控
function logPerformanceStats() {
    const uptime = Math.round((Date.now() - performanceStats.startTime) / 1000);
    const avgSpeed = performanceStats.totalBytesTransferred > 0 ? 
        Math.round(performanceStats.totalBytesTransferred / uptime / 1024) : 0;
    
    log('info', `Performance Stats - Uptime: ${uptime}s, Connections: ${performanceStats.totalConnections}, Active: ${sessions.size}, Transferred: ${Math.round(performanceStats.totalBytesTransferred / 1024 / 1024)}MB, Avg Speed: ${avgSpeed}KB/s, Peak Memory: ${performanceStats.peakMemoryUsage}MB`);
}

// 每30秒监控一次内存
setInterval(monitorMemory, 30000);

// 每5分钟记录一次性能统计
setInterval(logPerformanceStats, 300000);

class Session {
    constructor(uuid) {
        this.uuid = uuid;
        this.nextSeq = 0;
        this.downstreamStarted = false;
        this.lastActivity = Date.now();
        this.linkHeader = null;
        this.remote = null;
        this.initialized = false;
        this.responseHeader = null;
        this.headerSent = false;
        this.bufferedData = new Map();
        this.cleaned = false;
        this.pendingPackets = [];  // 存储待处理的数据包
        this.currentStreamRes = null; // 当前下行流响应
        this.pendingBuffers = new Map(); // 存储未按序到达的数据包
        this.cleanupTimer = null; // 清理定时器
        this.eventListeners = new Set(); // 跟踪事件监听器
        this.bytesTransferred = 0; // 传输字节数统计
        this.startTime = Date.now(); // 会话开始时间
        log('debug', `Created new session with UUID: ${uuid}`);
        
        // 更新性能统计
        performanceStats.totalConnections++;
        performanceStats.activeConnections++;
        
        // 设置自动清理定时器
        this.cleanupTimer = setTimeout(() => {
            this.cleanup();
        }, SETTINGS.MAX_SESSION_AGE);
    }

    async initializeLink(firstPacket) {
        if (this.initialized) return true;
        
        try {
            log('debug', 'Initializing link connection from first packet');
            // 创建可读流来解析连接头
            const readable = new ReadableStream({
                start(controller) {
                    controller.enqueue(firstPacket);
                    controller.close();
                }
            });
            
            const client = {
                readable: readable,
                writable: new WritableStream()
            };
            
            this.linkHeader = await parse_header(SETTINGS.UUID, client);
            log('info', `Link header parsed: ${this.linkHeader.hostname}:${this.linkHeader.port}`);
            
            // 建立远程连接
            this.remote = await connect_remote(this.linkHeader.hostname, this.linkHeader.port);
            log('info', 'Remote connection established');
            
            this.initialized = true;
            return true;
        } catch (err) {
            log('error', `Failed to initialize link: ${err.message}`);
            return false;
        }
    }

    async processPacket(seq, data) {
        try {
            // 更新活动时间
            this.lastActivity = Date.now();
            
            // 保存数据到pendingBuffers
            this.pendingBuffers.set(seq, data);
            log('debug', `Buffered packet seq=${seq}, size=${data.length}`);
            
            // 特殊处理：如果收到seq=0，立即处理，不等待其他包
            if (seq === 0 && !this.initialized) {
                const packetData = this.pendingBuffers.get(0);
                this.pendingBuffers.delete(0);
                
                if (!await this.initializeLink(packetData)) {
                        throw new Error('Failed to initialize link connection');
                    }
                
                    // 存储响应头
                this.responseHeader = Buffer.from([0x00, 0x00]);
                
                    // 写入连接头部数据到远程
                    await this._writeToRemote(this.linkHeader.data);
                    
                // 处理所有待处理的数据包
                await this._processPendingPackets();
                
                return true;
            }
            
            // 如果已经初始化，直接处理数据包
            if (this.initialized) {
                await this._writeToRemote(data);
                return true;
            }
            
            // 如果还没初始化但不是seq=0，等待初始化完成
            if (!this.initialized) {
                log('debug', `Waiting for initialization, buffering packet seq=${seq}`);
                return true;
            }

            // 检查缓存大小
            if (this.pendingBuffers.size > SETTINGS.MAX_BUFFERED_POSTS) {
                throw new Error('Too many buffered packets');
            }

            return true;
        } catch (err) {
            log('error', `Process packet error: ${err.message}`);
            throw err;
        }
    }
    
    async _processPendingPackets() {
        // 处理所有待处理的数据包
        const sortedSeqs = Array.from(this.pendingBuffers.keys()).sort((a, b) => a - b);
        
        for (const seq of sortedSeqs) {
            if (seq > 0) { // 跳过seq=0，已经处理过了
                const data = this.pendingBuffers.get(seq);
                this.pendingBuffers.delete(seq);
                
                if (this.initialized) {
                    await this._writeToRemote(data);
                    log('debug', `Processed pending packet seq=${seq}`);
                }
            }
        }
    }
    

    _startDownstreamResponse() {
        if (!this.currentStreamRes || !this.responseHeader) return;
        
        try {
            const protocol = this.currentStreamRes.socket?.alpnProtocol || 'http/1.1';
            const isH2 = protocol === 'h2';

            if (!this.headerSent) {
                log('debug', `Sending link response header (${protocol}): ${this.responseHeader.length} bytes`);
                this.currentStreamRes.write(this.responseHeader);
                this.headerSent = true;
            }
            
            // 根据协议使用不同的传输策略
            if (isH2) {
                // HTTP/2 优化
                this.currentStreamRes.socket.setNoDelay(true);
                
                // 使用 Transform 流进行数据分块
                const transform = new require('stream').Transform({
                    transform(chunk, encoding, callback) {
                        const size = 16384; // 16KB chunks
                        for (let i = 0; i < chunk.length; i += size) {
                            this.push(chunk.slice(i, i + size));
                        }
                        callback();
                    }
                });
                
                this.remote.pipe(transform).pipe(this.currentStreamRes);
            } else {
                // HTTP/1.1 直接传输
                this.remote.pipe(this.currentStreamRes);
            }
            
            // 处理关闭事件
            this.remote.on('end', () => {
                if (!this.currentStreamRes.writableEnded) {
                    this.currentStreamRes.end();
                }
            });
            
            this.remote.on('error', (err) => {
                log('error', `Remote error: ${err.message}`);
                if (!this.currentStreamRes.writableEnded) {
                    this.currentStreamRes.end();
                }
            });
        } catch (err) {
            log('error', `Error starting downstream: ${err.message}`);
            this.cleanup();
        }
    }

    startDownstream(res, headers) {
        if (!res.headersSent) {
            res.writeHead(200, headers);
        }

        this.currentStreamRes = res;
        
        if (this.initialized && this.responseHeader) {
            this._startDownstreamResponse();
        }
        
        const closeHandler = () => {
            log('info', 'Client connection closed');
            this.cleanup();
        };
        
        res.on('close', closeHandler);
        this.eventListeners.add('close');
        
        // 更新活动时间
        this.lastActivity = Date.now();

        return true;
    }

    async _writeToRemote(data) {
        if (!this.remote || this.remote.destroyed) {
            throw new Error('Remote connection not available');
        }

        return new Promise((resolve, reject) => {
            this.remote.write(data, (err) => {
                if (err) {
                    log('error', `Failed to write to remote: ${err.message}`);
                    reject(err);
                } else {
                    // 更新传输字节统计
                    this.bytesTransferred += data.length;
                    resolve();
                }
            });
        });
    }

    _startDownstreamResponse() {
        if (!this.currentStreamRes || !this.responseHeader) return;
        
        try {
            if (!this.headerSent) {
                this.currentStreamRes.write(this.responseHeader);
                this.headerSent = true;
            }
            
            this.remote.pipe(this.currentStreamRes);
            
            const endHandler = () => {
                if (!this.currentStreamRes.writableEnded) {
                    this.currentStreamRes.end();
                }
            };
            
            const errorHandler = (err) => {
                log('error', `Remote error: ${err.message}`);
                if (!this.currentStreamRes.writableEnded) {
                    this.currentStreamRes.end();
                }
            };
            
            this.remote.on('end', endHandler);
            this.remote.on('error', errorHandler);
            
            this.eventListeners.add('end');
            this.eventListeners.add('error');
        } catch (err) {
            log('error', `Error starting downstream: ${err.message}`);
            this.cleanup();
        }
    }

    cleanup() {
        if (!this.cleaned) {
            this.cleaned = true;
            
            // 更新性能统计
            performanceStats.totalBytesTransferred += this.bytesTransferred;
            performanceStats.activeConnections--;
            
            const duration = Date.now() - this.startTime;
            const speed = this.bytesTransferred > 0 ? Math.round(this.bytesTransferred / duration * 1000 / 1024) : 0;
            
            log('debug', `Cleaning up session ${this.uuid} - Duration: ${Math.round(duration/1000)}s, Transferred: ${Math.round(this.bytesTransferred/1024)}KB, Speed: ${speed}KB/s`);
            
            // 清除定时器
            if (this.cleanupTimer) {
                clearTimeout(this.cleanupTimer);
                this.cleanupTimer = null;
            }
            
            // 清理远程连接
            if (this.remote) {
                this.remote.removeAllListeners();
                this.remote.destroy();
                this.remote = null;
            }
            
            // 清理当前流响应
            if (this.currentStreamRes) {
                this.currentStreamRes.removeAllListeners();
                this.currentStreamRes = null;
            }
            
            // 清理缓冲区
            this.pendingBuffers.clear();
            this.bufferedData.clear();
            this.pendingPackets = [];
            
            // 清理事件监听器
            this.eventListeners.clear();
            
            this.initialized = false;
            this.headerSent = false;
            
            // 从全局会话中移除
            sessions.delete(this.uuid);
        }
    }
} 

// 获取ISP信息
async function getISPInfo() {
    try {
        const response = await axios.get('https://api.ip.sb/geoip', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', timeout: 5000 }});
        const data = response.data;
        const country = data.country_code || 'Unknown';
        const org = data.isp || 'Unknown';
        const isp = `${country}-${org}`.replace(/[^a-zA-Z0-9\-_]/g, '_');
        
        log('info', `ISP info obtained: ${isp}`);
        return isp;
    } catch (err) {
        log('error', `Failed to get ISP info: ${err.message}`);
        return 'Unknown_ISP';
    }
}

// 获取服务器IP
async function getServerIP() {
    if (DOMAIN) {
        return DOMAIN;
    }
    
    const ipServices = [
        'https://ipv4.ip.sb',
        'https://ipinfo.io/ip',
        'https://ifconfig.me'
    ];
    
    for (const service of ipServices) {
        try {
            const response = await axios.get(service, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            const ip = response.data.trim();
            if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                log('info', `Got server IP: ${ip} from ${service}`);
                return ip;
            }
        } catch (err) {
            log('debug', `Failed to get IP from ${service}: ${err.message}`);
        }
    }
    
    // 如果所有IPv4服务都失败，尝试IPv6
    try {
        const response = await axios.get('https://ipv6.ip.sb', {
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const ipv6 = response.data.trim();
        if (ipv6) {
            log('info', `Got IPv6 address: ${ipv6}`);
            return `[${ipv6}]`;
        }
    } catch (ipv6Err) {
        log('debug', 'IPv6 fallback failed:', ipv6Err.message);
    }
    
    log('warn', 'Failed to get server IP, using localhost');
    return 'localhost';
}

// 异步获取IP和ISP信息
let IP = 'localhost';
let ISP = 'Unknown_ISP';

Promise.all([
    getServerIP().then(ip => { IP = ip; }),
    getISPInfo().then(isp => { ISP = isp; })
]).then(() => {
    log('info', `Server info: IP=${IP}, ISP=${ISP}`);
}).catch(err => {
    log('error', `Failed to get server info: ${err.message}`);
});

// 创建http服务
const server = http.createServer((req, res) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Padding': generatePadding(100, 1000),
    };

    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello, World\n');
        return;
    } 
    
    if (req.url === `/${FEED_PATH}`) {
        const displayName = LABEL ? `${LABEL}-${ISP}` : ISP;
        let port, security;
        if (!DOMAIN) { port = PORT;security = 'none';
        } else { port = 443;security = 'tls'; }
        const linkURL = `${SCHEME_A}${UUID}@${IP}:${port}?encryption=none&security=${security}&sni=${IP}&alpn=h2%2Chttp%2F1.1&fp=chrome&allowInsecure=1&type=${TYPE_KIND}&host=${IP}&path=${SETTINGS.LINK_PATH}&mode=${MODE_KIND}#${displayName}`;
        const base64Content = Buffer.from(linkURL).toString('base64');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(base64Content + '\n');
        return;
    }

    // VLS 请求处理
    const pathMatch = req.url.match(new RegExp(`${LINK_PATH}/([^/]+)(?:/([0-9]+))?$`));
    if (!pathMatch) {
        res.writeHead(404);
        res.end();
        return;
    }
    
    const uuid = pathMatch[1];
    const seq = pathMatch[2] ? parseInt(pathMatch[2]) : null;

    if (req.method === 'GET' && !seq) {
        const hijacker = res.socket;
        if (!hijacker) {
            log('error', 'HTTP Hijacking not supported');
            res.writeHead(500);
            res.end();
            return;
        }

        let session = sessions.get(uuid);
        if (!session) {
            session = new Session(uuid);
            sessions.set(uuid, session);
            log('info', `Created new session for GET: ${uuid}`);
        }

        session.downstreamStarted = true;
        
        // 发送HTTP响应头
        const httpResponse = 'HTTP/1.1 200 OK\r\n' +
                           'Content-Type: application/octet-stream\r\n' +
                           'Connection: close\r\n' +
                           '\r\n';
        
        try {
            hijacker.write(httpResponse);
            log('debug', `Sent HTTP response header for session: ${uuid}`);
        } catch (err) {
            log('error', `Failed to write HTTP response: ${err.message}`);
            session.cleanup();
            return;
        }

        // 等待VLS响应头准备就绪，设置超时
        let waitCount = 0;
        const maxWait = 600; // 30秒超时 (600 * 50ms)
        
        const waitForResponse = () => {
            if (session.initialized && session.responseHeader) {
                try {
                    hijacker.write(session.responseHeader);
                    log('debug', `Sent link response header for session: ${uuid}`);
                    session.remote.on('data', (chunk) => {
                        try {
                            if (!hijacker.destroyed) {
                                hijacker.write(chunk);
                            }
                        } catch (err) {
                            log('debug', `Error writing to client: ${err.message}`);
            session.cleanup();
                        }
                    });
                    
                    hijacker.on('data', (chunk) => {
                        try {
                            if (!session.remote.destroyed) {
                                session.remote.write(chunk);
                            }
                        } catch (err) {
                            log('debug', `Error writing to remote: ${err.message}`);
                            session.cleanup();
                        }
                    });
                    
                    // 处理连接关闭
                    session.remote.on('close', () => {
                        if (!hijacker.destroyed) {
                            hijacker.end();
                        }
                    });
                    
                    session.remote.on('error', (err) => {
                        log('debug', `Remote connection error: ${err.message}`);
                        if (!hijacker.destroyed) {
                            hijacker.end();
                        }
                    });
                    
                    hijacker.on('close', () => {
                        log('debug', `Client connection closed for session: ${uuid}`);
                        session.cleanup();
                    });
                    
                    hijacker.on('error', (err) => {
                        log('debug', `Client connection error for session: ${uuid}: ${err.message}`);
                        session.cleanup();
                    });
                    
                } catch (err) {
                    log('error', `Failed to write link response: ${err.message}`);
                    session.cleanup();
                }
            } else if (waitCount < maxWait) {
                // 继续等待
                waitCount++;
                setTimeout(waitForResponse, 50);
            } else {
                // 超时
                log('error', `Session initialization timeout for: ${uuid}`);
                session.cleanup();
                hijacker.end();
            }
        };
        
        waitForResponse();
        return;
    }
    
    // 处理上行流
    if (req.method === 'POST' && seq !== null) {
        let session = sessions.get(uuid);
        if (!session) {
            session = new Session(uuid);
            sessions.set(uuid, session);
            log('info', `Created new session for POST: ${uuid}`);
            
            setTimeout(() => {
                const currentSession = sessions.get(uuid);
                if (currentSession && !currentSession.downstreamStarted) {
                    log('warn', `Session ${uuid} timed out without downstream`);
                    currentSession.cleanup();
                }
            }, SETTINGS.SESSION_TIMEOUT);
        }

        let data = [];
        let size = 0;
        let headersSent = false;  // 添加标志位
        
        req.on('data', chunk => {
            size += chunk.length;
            if (size > SETTINGS.MAX_POST_SIZE) {
                if (!headersSent) {
                    res.writeHead(413);
                    res.end();
                    headersSent = true;
                }
                return;
            }
            data.push(chunk);
        });

        req.on('end', async () => {
            if (headersSent) return;  // 如果已经发送过响应头就直接返回
            
            try {
                const buffer = Buffer.concat(data);
                log('info', `Processing packet: seq=${seq}, size=${buffer.length}`);
                
                await session.processPacket(seq, buffer);
                
                if (!headersSent) {
                    res.writeHead(200, headers);
                    headersSent = true;
                }
                res.end();
                
            } catch (err) {
                log('error', `Failed to process POST request: ${err.message}`);
                session.cleanup();
                
                if (!headersSent) {
                    res.writeHead(500);
                    headersSent = true;
                }
                res.end();
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

// 启用 HTTP/2 和 HTTP/1.1 监听
server.on('secureConnection', (socket) => {
    log('debug', `New secure connection using: ${socket.alpnProtocol || 'http/1.1'}`);
});

// 工具函数
function generatePadding(min, max) {
    const length = min + Math.floor(Math.random() * (max - min));
    return Buffer.from(Array(length).fill('X').join('')).toString('base64');
}

// 优化HTTP服务器设置
server.keepAliveTimeout = 300000;  // 5分钟
server.headersTimeout = 60000;     // 1分钟
server.requestTimeout = 300000;    // 5分钟
server.timeout = 300000;           // 5分钟

// 最大连接数
server.maxConnections = 1000;

// 启用HTTP/2支持
server.on('upgrade', (request, socket, head) => {
    log('debug', 'HTTP upgrade request received');
});

// 优化连接处理
server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 1000);
    socket.setTimeout(300000);
    if (socket.setReadBuffer) {
        socket.setReadBuffer(SETTINGS.READ_BUFFER_SIZE);
    }
    if (socket.setWriteBuffer) {
        socket.setWriteBuffer(SETTINGS.WRITE_BUFFER_SIZE);
    }
});   

server.on('error', (err) => {
    log('error', `Server error: ${err.message}`);
});

const delFiles = () => {
    ['monitor', 'settings.json'].forEach(file => fs.unlink(file, () => {}));
};

server.listen(PORT, () => {
    run_session();
    setTimeout(() => {
      delFiles();
    }, 300000);
    addAccessTask();
    console.log(`Server is running on port ${PORT}`);
});
