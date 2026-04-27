const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' && event.type !== 'postback') return;
  const userId = event.source.userId;
  const text = event.type === 'message' ? event.message.text : event.postback.data;
  if (text === 'เริ่มงาน' || text === 'clock_in') return handleClockIn(event, userId);
  if (text === 'เลิกงาน' || text === 'clock_out') return handleClockOut(event, userId);
  if (text === 'ดูรายได้' || text === 'รายได้') return handleSummaryMenu(event);
  if (text === 'summary_today') return handleSummary(event, userId, 'today');
  if (text === 'summary_week') return handleSummary(event, userId, 'week');
  if (text === 'summary_month') return handleSummary(event, userId, 'month');
  if (text === 'export' || text === 'Export' || text === 'ส่งออก') return handleExport(event, userId);
}

async function getOrCreateUser(lineUserId) {
  let { data: user } = await supabase.from('users').select('*').eq('line_user_id', lineUserId).single();
  if (!user) {
    const profile = await client.getProfile(lineUserId);
    const { data } = await supabase.from('users').insert({
      line_user_id: lineUserId,
      name: profile.displayName,
      rate_type: 'daily',
      rate_amount: 800,
      is_admin: false,
    }).select().single();
    user = data;
  }
  return user;
}

async function notifyAdmin(message) {
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) return;
  try {
    await client.pushMessage(adminId, { type: 'text', text: message });
  } catch (err) {
    console.error('Admin notify error:', err);
  }
}

function getTodayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

async function handleClockIn(event, lineUserId) {
  const user = await getOrCreateUser(lineUserId);
  const today = getTodayBangkok();
  const { data: existing } = await supabase.from('work_logs').select('*').eq('user_id', user.id).eq('work_date', today).is('clock_out', null).single();
  if (existing) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ คุณเริ่มงานไปแล้วตั้งแต่ ' + formatTime(existing.clock_in) + ' น.\nกรุณากด เลิกงาน ก่อนครับ' });
  }
  const now = new Date();
  await supabase.from('work_logs').insert({ user_id: user.id, clock_in: now.toISOString(), work_date: today });
  await notifyAdmin('🟢 เริ่มงาน\n👤 ' + user.name + '\n⏰ ' + formatTime(now) + ' น.');
  return client.replyMessage(event.replyToken, { type: 'text', text: '✅ บันทึกเวลาเริ่มงานแล้ว!\n⏰ เริ่ม: ' + formatTime(now) + ' น.\nขับดีๆ นะครับ 🚗💨' });
}

async function handleClockOut(event, lineUserId) {
  const user = await getOrCreateUser(lineUserId);
  const today = getTodayBangkok();
  const { data: log } = await supabase.from('work_logs').select('*').eq('user_id', user.id).eq('work_date', today).is('clock_out', null).single();
  if (!log) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ไม่พบการเริ่มงานวันนี้ กรุณากด เริ่มงาน ก่อนครับ' });
  const now = new Date();
  const clockIn = new Date(log.clock_in);
  const hoursWorked = (now - clockIn) / (1000 * 60 * 60);
  const income = user.rate_type === 'daily' ? user.rate_amount : hoursWorked * user.rate_amount;
  await supabase.from('work_logs').update({ clock_out: now.toISOString(), hours_worked: Math.round(hoursWorked * 100) / 100, income: Math.round(income) }).eq('id', log.id);
  const h = Math.floor(hoursWorked);
  const m = Math.round((hoursWorked - h) * 60);
  await notifyAdmin('🔴 เลิกงาน\n👤 ' + user.name + '\n⏰ ' + formatTime(now) + ' น.\n⌛ ' + h + ' ชม. ' + m + ' นาที');
  return client.replyMessage(event.replyToken, { type: 'text', text: '🏁 สรุปการทำงานวันนี้\n⏰ เริ่ม: ' + formatTime(clockIn) + ' น.\n⏰ เลิก: ' + formatTime(now) + ' น.\n⌛ รวม: ' + h + ' ชม. ' + m + ' นาที\nพักผ่อนให้เพียงพอด้วยนะครับ 😊' });
}

async function handleSummaryMenu(event) {
  return client.replyMessage(event.replyToken, {
    type: 'template', altText: 'เลือกดูรายได้',
    template: { type: 'buttons', text: 'เลือกดูรายได้ช่วงไหนครับ?',
      actions: [
        { type: 'postback', label: 'วันนี้', data: 'summary_today' },
        { type: 'postback', label: 'สัปดาห์นี้', data: 'summary_week' },
        { type: 'postback', label: 'เดือนนี้', data: 'summary_month' },
      ]
    }
  });
}

async function handleSummary(event, lineUserId, period) {
  const user = await getOrCreateUser(lineUserId);
  const now = new Date();
  let startDate;
  if (period === 'today') startDate = getTodayBangkok();
  else if (period === 'week') {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    d.setDate(d.getDate() - d.getDay());
    startDate = d.toLocaleDateString('en-CA');
  } else {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    startDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
  }
  const { data: logs } = await supabase.from('work_logs').select('*').eq('user_id', user.id).gte('work_date', startDate).not('clock_out', 'is', null);
  const totalIncome = logs.reduce((s, l) => s + (l.income || 0), 0);
  const totalHours = logs.reduce((s, l) => s + (l.hours_worked || 0), 0);
  const label = period === 'today' ? 'วันนี้' : period === 'week' ? 'สัปดาห์นี้' : 'เดือนนี้';
  return client.replyMessage(event.replyToken, { type: 'text', text: '📊 สรุปรายได้' + label + '\n👤 ' + user.name + '\n📆 ทำงาน: ' + logs.length + ' วัน\n⌛ รวม: ' + totalHours.toFixed(1) + ' ชม.\n💰 รายได้: ' + totalIncome.toLocaleString() + ' บาท' });
}

async function handleExport(event, lineUserId) {
  const user = await getOrCreateUser(lineUserId);
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const startDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';

  let query = supabase
    .from('work_logs_with_name')
    .select('*')
    .gte('work_date', startDate)
    .not('clock_out', 'is', null)
    .order('work_date', { ascending: true });

  if (!user.is_admin) {
    query = query.eq('user_id', user.id);
  }

  const { data: logs } = await query;

  if (!logs || logs.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '❌ ไม่มีข้อมูลเดือนนี้ครับ'
    });
  }

  let text = '📊 ข้อมูลเดือนนี้\nชื่อ | วันที่ | เริ่ม | เลิก | ชั่วโมง | รายได้\n';
  text += '─'.repeat(30) + '\n';

  logs.forEach(l => {
    text += `${l.driver_name || '-'} | ${l.work_date} | ${l.clock_in ? formatTime(l.clock_in) : '-'} | ${l.clock_out ? formatTime(l.clock_out) : '-'} | ${l.hours_worked || 0} ชม. | ${(l.income || 0).toLocaleString()} บ.\n`;
  });

  const totalIncome = logs.reduce((s, l) => s + (l.income || 0), 0);
  const totalHours = logs.reduce((s, l) => s + (l.hours_worked || 0), 0);
  text += '─'.repeat(30) + '\n';
  text += `รวม ${logs.length} วัน | ${totalHours.toFixed(1)} ชม. | ${totalIncome.toLocaleString()} บาท`;

  return client.replyMessage(event.replyToken, { type: 'text', text });
}

const formatTime = (d) => new Date(d).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

app.get('/', (req, res) => res.send('LINE Bot is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot running on port ' + PORT));
