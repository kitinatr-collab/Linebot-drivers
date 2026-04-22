async function handleExport(event, lineUserId) {
  const user = await getOrCreateUser(lineUserId);
  const now = new Date();
  const startDate = now.getFullYear() + '-' + 
    String(now.getMonth() + 1).padStart(2, '0') + '-01';

  // ถ้าเป็น Admin → ดึงข้อมูลทุกคน
  // ถ้าเป็นคนขับ → ดึงเฉพาะตัวเอง
  let query = supabase
    .from('work_logs')
    .select('*, users(name)')
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

  const rows = logs.map(l => ({
    'ชื่อ': l.users?.name || '-',
    'วันที่': l.work_date,
    'เริ่มงาน': l.clock_in ? formatTime(l.clock_in) : '-',
    'เลิกงาน': l.clock_out ? formatTime(l.clock_out) : '-',
    'ชั่วโมงรวม': l.hours_worked || 0,
    'รายได้ (บาท)': l.income || 0,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 15 }, { wch: 12 }, { wch: 12 }, 
    { wch: 12 }, { wch: 14 }, { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'รายงาน');
  const filename = `report_all_${startDate}.xlsx`;
  const filepath = path.join('/tmp', filename);
  XLSX.writeFile(wb, filepath);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '📊 ไฟล์ Excel พร้อมแล้วครับ!\n📆 ' + logs.length + ' รายการ\n\n⬇️ กดดาวน์โหลด:\nhttps://linebot-drivers.onrender.com/download/' + filename
  });
}
