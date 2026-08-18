import ExcelJS from "exceljs";

const WEEKDAY_LABELS = Object.freeze(["日", "月", "火", "水", "木", "金", "土"]);
const HEADER_FILL = "FF274C5E";
const HEADER_TEXT = "FFFFFFFF";
const SATURDAY_FILL = "FFDCEBFA";
const SATURDAY_TEXT = "FF1D4F91";
const CLOSED_FILL = "FFFDE2E2";
const CLOSED_TEXT = "FF9E2A2B";
const HEADCOUNT_WARNING_FILL = "FFFFF1B8";
const HEADCOUNT_WARNING_TEXT = "FF6B4F00";
const HEADCOUNT_STRONG_FILL = "FFFFC857";
const HEADCOUNT_STRONG_TEXT = "FF4A2B00";
const BORDER_COLOR = "FFD7DEE3";

function safeExcelText(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function displayTime(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^0(?=\d:)/, "");
}

function slotLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}:${String(remainder).padStart(2, "0")}`;
}

function minutes(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function dateHeader(date) {
  return `${date.dayOfMonth}日\n(${WEEKDAY_LABELS[date.weekday]})`;
}

function applyHeaderStyle(cell, date = null) {
  const isClosed = date?.isClosure === true;
  const isSaturday = date?.isSaturday === true && !isClosed;
  cell.font = {
    bold: true,
    color: { argb: isClosed ? CLOSED_TEXT : isSaturday ? SATURDAY_TEXT : HEADER_TEXT },
  };
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: isClosed ? CLOSED_FILL : isSaturday ? SATURDAY_FILL : HEADER_FILL },
  };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = {
    top: { style: "thin", color: { argb: BORDER_COLOR } },
    left: { style: "thin", color: { argb: BORDER_COLOR } },
    bottom: { style: "thin", color: { argb: BORDER_COLOR } },
    right: { style: "thin", color: { argb: BORDER_COLOR } },
  };
}

function applyBodyStyle(cell, date = null) {
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = {
    top: { style: "thin", color: { argb: BORDER_COLOR } },
    left: { style: "thin", color: { argb: BORDER_COLOR } },
    bottom: { style: "thin", color: { argb: BORDER_COLOR } },
    right: { style: "thin", color: { argb: BORDER_COLOR } },
  };
  if (date?.isClosure) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2F2" } };
  } else if (date?.isSaturday) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F8FD" } };
  }
}

function headcountAlertLevel(slot, count) {
  if (!Number.isInteger(slot) || !Number.isInteger(count) || count < 0) return "normal";
  if (slot >= 7 * 60 && slot < 12 * 60) {
    if (count >= 10) return "strong";
    if (count >= 7) return "warning";
    return "normal";
  }
  if (slot >= 12 * 60 && slot <= 20 * 60) {
    if (count >= 9) return "strong";
    if (count >= 6) return "warning";
  }
  return "normal";
}

function applyHeadcountAlertStyle(cell, slot, count) {
  const level = headcountAlertLevel(slot, count);
  if (level === "normal") return;
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: level === "strong" ? HEADCOUNT_STRONG_FILL : HEADCOUNT_WARNING_FILL },
  };
  cell.font = {
    bold: level === "strong",
    color: { argb: level === "strong" ? HEADCOUNT_STRONG_TEXT : HEADCOUNT_WARNING_TEXT },
  };
}

function configurePage(worksheet, repeatColumns) {
  worksheet.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.2, right: 0.2, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 },
  };
  worksheet.pageSetup.printTitlesRow = "1:2";
  worksheet.pageSetup.printTitlesColumn = repeatColumns;
  worksheet.headerFooter.oddFooter = "&L対象月の利用予定&R&P / &N";
}

function buildMonthlyScheduleSheet(workbook, data) {
  const worksheet = workbook.addWorksheet("園児利用予定", {
    views: [{ state: "frozen", xSplit: 2, ySplit: 2, topLeftCell: "C3" }],
  });
  worksheet.mergeCells(1, 1, 1, data.dates.length + 2);
  const title = worksheet.getCell(1, 1);
  title.value = `園児利用予定 ${data.period.targetMonth}`;
  title.font = { bold: true, size: 14, color: { argb: HEADER_TEXT } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  title.alignment = { horizontal: "left", vertical: "middle" };
  worksheet.getRow(1).height = 24;

  const header = worksheet.getRow(2);
  header.values = ["園児名", "提出状態", ...data.dates.map(dateHeader)];
  header.height = 38;
  applyHeaderStyle(header.getCell(1));
  applyHeaderStyle(header.getCell(2));
  data.dates.forEach((date, index) => applyHeaderStyle(header.getCell(index + 3), date));

  data.children.forEach((child, childIndex) => {
    const row = worksheet.getRow(childIndex + 3);
    row.getCell(1).value = safeExcelText(child.name);
    row.getCell(2).value = child.submissionStatus === "submitted" ? "提出済み" : "未提出";
    row.getCell(2).font = child.submissionStatus === "submitted"
      ? { color: { argb: "FF246B4A" } }
      : { bold: true, color: { argb: CLOSED_TEXT } };
    applyBodyStyle(row.getCell(1));
    applyBodyStyle(row.getCell(2));
    child.days.forEach((day, dayIndex) => {
      const date = data.dates[dayIndex];
      const cell = row.getCell(dayIndex + 3);
      if (day.usageStatus === "using") {
        cell.value = `${displayTime(day.arrivalTime)}〜${displayTime(day.departureTime)}`;
      } else if (day.usageStatus === "closed") {
        cell.value = "休園";
      } else if (day.usageStatus === "not_enrolled") {
        cell.value = "対象外";
      } else if (day.usageStatus === "off") {
        cell.value = "休み";
      } else {
        cell.value = "";
      }
      applyBodyStyle(cell, date);
    });
    row.height = 28;
  });

  const totalRow = worksheet.getRow(data.children.length + 3);
  totalRow.getCell(1).value = "利用予定人数";
  totalRow.getCell(2).value = "";
  applyHeaderStyle(totalRow.getCell(1));
  applyHeaderStyle(totalRow.getCell(2));
  data.dates.forEach((date, index) => {
    const count = date.isClosure ? 0 : data.children.reduce((total, child) => (
      total + (child.submissionStatus === "submitted" && child.days[index]?.usageStatus === "using" ? 1 : 0)
    ), 0);
    const cell = totalRow.getCell(index + 3);
    cell.value = count;
    applyHeaderStyle(cell, date);
  });

  worksheet.getColumn(1).width = 18;
  worksheet.getColumn(2).width = 11;
  for (let column = 3; column <= data.dates.length + 2; column += 1) worksheet.getColumn(column).width = 12;
  worksheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: data.dates.length + 2 } };
  configurePage(worksheet, "1:2");
  return worksheet;
}

function buildHeadcountSheet(workbook, data) {
  const worksheet = workbook.addWorksheet("時間帯別人数", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 2, topLeftCell: "B3" }],
  });
  worksheet.mergeCells(1, 1, 1, data.dates.length + 1);
  const title = worksheet.getCell(1, 1);
  title.value = `時間帯別人数 ${data.period.targetMonth}`;
  title.font = { bold: true, size: 14, color: { argb: HEADER_TEXT } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  title.alignment = { horizontal: "left", vertical: "middle" };
  worksheet.getRow(1).height = 24;

  const header = worksheet.getRow(2);
  header.values = ["時刻", ...data.dates.map(dateHeader)];
  header.height = 38;
  applyHeaderStyle(header.getCell(1));
  data.dates.forEach((date, index) => applyHeaderStyle(header.getCell(index + 2), date));

  for (let slot = 7 * 60, rowIndex = 3; slot <= 20 * 60; slot += 5, rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    row.getCell(1).value = slotLabel(slot);
    applyHeaderStyle(row.getCell(1));
    data.dates.forEach((date, dateIndex) => {
      const count = date.isClosure ? 0 : data.children.reduce((total, child) => {
        if (child.submissionStatus !== "submitted") return total;
        const day = child.days[dateIndex];
        if (day?.usageStatus !== "using") return total;
        const arrival = minutes(day.arrivalTime);
        const departure = minutes(day.departureTime);
        return total + (arrival !== null && departure !== null && arrival <= slot && slot <= departure ? 1 : 0);
      }, 0);
      const cell = row.getCell(dateIndex + 2);
      cell.value = count;
      applyBodyStyle(cell, date);
      applyHeadcountAlertStyle(cell, slot, count);
    });
    row.height = 20;
  }

  worksheet.getColumn(1).width = 10;
  for (let column = 2; column <= data.dates.length + 1; column += 1) worksheet.getColumn(column).width = 8;
  configurePage(worksheet, "1:1");
  return worksheet;
}

export function buildFamilyScheduleWorkbook(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Nursery Schedule System";
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  workbook.calcProperties.fullCalcOnLoad = false;
  buildMonthlyScheduleSheet(workbook, data);
  buildHeadcountSheet(workbook, data);
  return workbook;
}

export async function createFamilyScheduleExcel(data) {
  const workbook = buildFamilyScheduleWorkbook(data);
  const bytes = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(bytes),
    filename: `nursery-schedule-${data.period.targetMonth}.xlsx`,
  };
}

export { headcountAlertLevel, safeExcelText };
