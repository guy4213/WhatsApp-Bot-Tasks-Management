# CRM Task Analysis

קריאה בלבד. **לא בוצע שינוי קוד/DB/TaskField.**

## סיכום ספירות

| קטגוריה | ספירה | אחוז |
|---|---:|---:|
| FIELD_PROCESS_CANDIDATE | 15 | 36% |
| NON_FIELD_TASK | 0 | 0% |
| EXCLUDED | 15 | 36% |
| NEEDS_CONTEXT | 12 | 29% |
| **Total** | **42** | 100% |

## type + currentStage per category

### FIELD_PROCESS_CANDIDATE (15)

| type / stage | ספירה |
|---|---:|
| step4 / stage=3 | 5 |
| stepQuote / stage=99 | 5 |
| step6 / stage=5 | 2 |
| step3 / stage=2 | 1 |
| step5 / stage=4 | 1 |
| step1 / stage=0 | 1 |

### NON_FIELD_TASK (0)

| type / stage | ספירה |
|---|---:|

### EXCLUDED (15)

| type / stage | ספירה |
|---|---:|
| step1 / stage=0 | 8 |
| step4 / stage=3 | 4 |
| step1 / stage=null | 3 |

### NEEDS_CONTEXT (12)

| type / stage | ספירה |
|---|---:|
| step1 / stage=0 | 8 |
| stepQuote / stage=99 | 3 |
| step4 / stage=3 | 1 |

## productName → InspectionType mapping (from real data)

| productName | ספירה | InspectionType.code | labelHe | family | status |
|---|---:|---|---|---|---|
| 69 | 6 | 69 | אוויר – דיגום עובשים באוויר – בדיקה ראשונה | air | ✅ matched |
| 72 | 3 | 72 | אוויר – בדיקת איכות אוויר תוך מבני | air | ✅ matched |
| 10000 | 2 | 10000 | ראדון – ערכה לבדיקת גז ראדון ארוכת טווח | radon | ✅ matched |
| 10064 | 2 | 10064 | קרינה – בדיקת קרינה מרכב היברידי / חשמלי | radiation | ✅ matched |
| 10096 | 2 | — | — | — | ❌ no match |
| 9 | 1 | 9 | קרינה – בדיקת קרינה אלקטרומגנטית מרשת החשמל | radiation | ✅ matched |
| 73 | 1 | 73 | רעש – בדיקת רעש סביבתית עפ״י סעיף 1 | noise | ✅ matched |
| 10003 | 1 | 10003 | ריח – בדיקת ריח ע״י צוות מריחים | odor | ✅ matched |
| 10006 | 1 | 10006 | קרינה – ייעוץ ופיקוח עליון לאחר בנייה (ELF היתר) | radiation | ✅ matched |
| 10011 | 1 | 10011 | רעש – בדיקת רעש סביבתית רציפה עד 24 שעות | noise | ✅ matched |
| 10013 | 1 | 10013 | ריח – איתור וסילוק מטרד ריח | odor | ✅ matched |
| 10026 | 1 | 10026 | אסבסט – זיהוי צובר אסבסט | asbestos | ✅ matched |
| 10088 | 1 | 10088 | קרקע – דיגום נוסף באתר חיידקים בחול תחת ריצוף | soil | ✅ matched |
| 10098 | 1 | — | — | — | ❌ no match |
| 10168 | 1 | — | — | — | ❌ no match |
| RF – קרינה – בדיקת קרינה אלקטרומגנטית ממתקני שידור ואנטנות ס | 1 | — | — | — | ❌ no match |

## Existing TaskField rows (already spawned field visits)

| taskId | title | classification | TaskField count |
|---|---|---|---:|
| qa-tracking-flow-guy-task | [QA_TEST] בדיקת קרינה פיקטיבית - גיא פרנסס | EXCLUDED | 1 |
| demo-yoram-task-1783939655645 | 🧪 [דמו — יורם] בדיקת הבוט של גיא — התעלמו | EXCLUDED | 1 |

**הערה חשובה:** שני ה-TaskField הקיימים במסד הם רשומות **QA/דמו של הבוט** (`[QA_TEST]` ו-`🧪 [דמו — יורם]`), לא לקוחות אמיתיים. הם סווגו EXCLUDED.

## עד 10 דוגמאות ברורות — FIELD_PROCESS_CANDIDATE (15 סה"כ)

| # | title | product | customer | stage | conf | primary reason |
|---|---|---|---|---|---:|---|
| 1 | כרטיס לקוח חדש | 10013 → odor | רמת אביב ג' ניהול ואחזקה בע"מ | step4/3 | 0.9 | productName="10013" מתחזה ל-InspectionType "ריח – איתור וסילוק מטרד ריח" (family |
| 2 | כרטיס לקוח חדש | 10000 → radon | בתיה טוקטלי - טאי טו | step6/5 | 0.9 | productName="10000" מתחזה ל-InspectionType "ראדון – ערכה לבדיקת גז ראדון ארוכת ט |
| 3 | פנייה - נעמי לשם | 10000 → radon | נעמי לשם | step3/2 | 0.9 | productName="10000" מתחזה ל-InspectionType "ראדון – ערכה לבדיקת גז ראדון ארוכת ט |
| 4 | כרטיס לקוח חדש | 69 → air | בי ווי הפקות והשעות בע"מ | step4/3 | 0.9 | productName="69" מתחזה ל-InspectionType "אוויר – דיגום עובשים באוויר – בדיקה ראש |
| 5 | פנייה - זהר שמר ניהול פרויקטים בע"מ | 10006 → radiation | זהר שמר ניהול פרויקטים בע"מ | step4/3 | 0.9 | productName="10006" מתחזה ל-InspectionType "קרינה – ייעוץ ופיקוח עליון לאחר בניי |
| 6 | כרטיס לקוח חדש | 73 → noise | יפה סטון | stepQuote/99 | 0.9 | productName="73" מתחזה ל-InspectionType "רעש – בדיקת רעש סביבתית עפ״י סעיף 1" (f |
| 7 | כרטיס לקוח חדש | 10026 → asbestos | דוד עזרן | stepQuote/99 | 0.9 | productName="10026" מתחזה ל-InspectionType "אסבסט – זיהוי צובר אסבסט" (family=as |
| 8 | פנייה - שגרירות אוסטרליה | 69 → air | שגרירות אוסטרליה | step6/5 | 0.9 | productName="69" מתחזה ל-InspectionType "אוויר – דיגום עובשים באוויר – בדיקה ראש |
| 9 | פנייה - עדי ירדן | 69 → air | עדי ירדן | step5/4 | 0.9 | productName="69" מתחזה ל-InspectionType "אוויר – דיגום עובשים באוויר – בדיקה ראש |
| 10 | כרטיס לקוח חדש | 10003 → odor | רובי סלם | step4/3 | 0.9 | productName="10003" מתחזה ל-InspectionType "ריח – בדיקת ריח ע״י צוות מריחים" (fa |

## עד 10 דוגמאות ברורות — NON_FIELD_TASK (0 סה"כ)

_אין פריטים._

## עד 10 דוגמאות ברורות — EXCLUDED (15 סה"כ)

| # | title | product | customer | stage | conf | primary reason |
|---|---|---|---|---|---:|---|
| 1 | [QA_TEST] בדיקת קרינה פיקטיבית - גיא פרנ | 9 → radiation | [QA_TEST] גיא פרנסס | step1/null | 0.98 | title מכיל סימון בדיקה/דמו — לא ליבוא |
| 2 | 🧪 [דמו — יורם] בדיקת הבוט של גיא — התעל | RF – קרינה – בדיקת קרינה אלקטרומגנטית ממ (no IT) | 🧪 [דמו — יורם] לקוח לבדיקת הב | step1/null | 0.98 | title מכיל סימון בדיקה/דמו — לא ליבוא |
| 3 | [QA_TEST_1338] משימה משרדית — בדיקת תזכו | — | — | step1/null | 0.98 | title מכיל סימון בדיקה/דמו — לא ליבוא |
| 4 | כרטיס לקוח חדש | — | מיקי קורן | step1/0 | 0.95 | בוטל בגלל: לא ניתן ליצור קשר |
| 5 | כרטיס לקוח חדש | — | ירון | step1/0 | 0.95 | בוטל בגלל: אי פרטי יצירת קשר |
| 6 | פנייה - חיים ג'ון כהן | 72 → air | חיים ג'ון כהן | step4/3 | 0.95 | בוטל בגלל: טסט |
| 7 | פנייה - חיים ג'ון כהן | 72 → air | חיים ג'ון כהן | step1/0 | 0.95 | בוטל בגלל: יקר מדי |
| 8 | כרטיס לקוח חדש | — | — | step1/0 | 0.95 | בוטל בגלל: לא מעוניין |
| 9 | כרטיס לקוח חדש | — | — | step1/0 | 0.95 | בוטל בגלל: לא מעוניין |
| 10 | כרטיס לקוח חדש | — | — | step1/0 | 0.95 | בוטל בגלל: לא מעוניין |

## עד 10 דוגמאות ברורות — NEEDS_CONTEXT (12 סה"כ)

| # | title | product | customer | stage | conf | primary reason |
|---|---|---|---|---|---:|---|
| 1 | כרטיס לקוח חדש | — | — | step1/0 | 0.85 | כרטיס ריק — אין productName, אין customer. יידרש context נוסף כדי לסווג |
| 2 | כרטיס לקוח חדש | — | — | step1/0 | 0.85 | כרטיס ריק — אין productName, אין customer. יידרש context נוסף כדי לסווג |
| 3 | ליד חדש נכנס | — | — | step1/0 | 0.85 | כרטיס ריק — אין productName, אין customer. יידרש context נוסף כדי לסווג |
| 4 | כרטיס לקוח חדש | — | — | step1/0 | 0.85 | כרטיס ריק — אין productName, אין customer. יידרש context נוסף כדי לסווג |
| 5 | כרטיס לקוח חדש | — | — | step1/0 | 0.85 | כרטיס ריק — אין productName, אין customer. יידרש context נוסף כדי לסווג |
| 6 | כרטיס לקוח חדש | — | — | step1/0 | 0.85 | כרטיס ריק — אין productName, אין customer. יידרש context נוסף כדי לסווג |
| 7 | כרטיס לקוח חדש | — | — | step1/0 | 0.85 | כרטיס ריק — אין productName, אין customer. יידרש context נוסף כדי לסווג |
| 8 | ליד חדש נכנס | — | נקסט טאוור | step1/0 | 0.7 | יש לקוח, אין productName — עדיין מוקדם להחליט האם יוליד משימת שטח |
| 9 | פנייה - חברת רום גבס | 10096 (no IT) | חברת רום גבס | stepQuote/99 | 0.5 | productName="10096" לא מופיע ב-InspectionType.code (יתכן שהוסר או שהוא מוצר משני |
| 10 | כרטיס לקוח — יצחק עופר בע"מ | 10096 (no IT) | יצחק עופר בע"מ | stepQuote/99 | 0.5 | productName="10096" לא מופיע ב-InspectionType.code (יתכן שהוסר או שהוא מוצר משני |

## שדות חסרים לחיבור עתידי בין אירועי Outlook לתהליכי CRM

כדי לשייך אירוע מ-Outlook לרשומת Task, אין כרגע שדה מקשר ישיר. השדות הבאים חסרים או לא בשימוש:

| שדה | סטטוס בפועל | השלכה |
|---|---|---|
| `Task.leadId` → Lead | **0/42 בשימוש** | לא נוכל לקשר Outlook↔Task דרך Lead |
| `Task.projectId` → Project | **0/42 בשימוש** | לא נוכל להשתמש ב-Project.siteVisitDate כ-key |
| `Task.dueDate` (יכול לשמש קרוב-בזמן ל-Outlook.start) | חסר ב-28/42 | קשר לא אמין |
| `Customer.address` | חסר ב-5 מהעם-לקוח | ניתן להשוות כתובת Outlook↔Customer רק אם קיימת |
| `Task.processNotes` (יכול להיות מפתח לחיפוש) | חסר ברוב | שיוך טקסטואלי חלש |
| **אין `outlookEventId` ב-Task** | לא קיים | נדרש שדה חדש (`Task.outlookEventId TEXT NULL`) או טבלת קישור |
| **אין `msObjectId`/`upn` ב-User** למיפוי owner→Outlook | קיים חלקי בסכימה (User.msEmail) | ניתן להשתמש כדי לזהות איזה owner יצר את האירוע |

### הצעה לשדות חדשים (לא ליישם עכשיו — רק תעד)

```sql
-- Option A: FK ישיר על Task
ALTER TABLE "Task" ADD COLUMN "outlookEventId" text NULL;
ALTER TABLE "Task" ADD COLUMN "outlookEventLinkedAt" timestamptz NULL;
CREATE INDEX ON "Task"("outlookEventId");

-- Option B: טבלת mapping נפרדת (אם Task↔Event הוא M:N)
CREATE TABLE "TaskOutlookEventLink" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId" text NOT NULL REFERENCES "Task"(id),
  "graphEventId" text NOT NULL,   -- מגיע מ-MicrosoftGraphEventLog.graphEventId
  "linkSource" text NOT NULL,     -- MANUAL / AUTO_HEURISTIC / AUTO_AI
  "confidence" numeric NULL,      -- אם AI
  "linkedAt" timestamptz DEFAULT now(),
  UNIQUE("taskId", "graphEventId")
);
```

## תובנות מרכזיות מהדאטה בפועל

1. **טבלת `Task` קטנה — 42 שורות בלבד.** זה לא CRM בוגר עם היסטוריה, אלא בעיקר queue של פניות עדכניות.
2. **`Task.productName` הוא בפועל `InspectionType.code`.** 21 מתוך 26 עם productName יש התאמה מדויקת. זו התובנה הכי חזקה.
3. **כל `InspectionType` הוא `isFieldInspection=true` (74/74).** משמע: **כל productName שיש לו התאמה ב-InspectionType הוא, מהגדרה, תהליך שטח פוטנציאלי.**
4. **`QuoteItemCatalog` ריק** — לא נוכל להסתמך על `requiresSiteVisit` שם. אולי לעתיד המוצר יאכלס את הטבלה, אבל היום לא רלוונטי.
5. **`leadId` / `projectId` לא בשימוש בכלל** על Task. הקשרים היחידים בפועל הם: customerId, incomingLeadId, ownerId.
6. **שני ה-TaskField הקיימים הם test/demo של הבוט** — אין אף רשומת TaskField אמיתית מלקוח.
7. **12/42 CANCELLED** — כולם עם סיבת ביטול קצרה ב-description ("לא מעוניין", "יקר מדי", "אי-התאמה"). תבנית ברורה.
8. **titles גנריים** — 15+ tasks עם `כרטיס לקוח חדש` (טקסט זהה) — הכותרת לא נושאת מידע. `type`+`stage` הם מקור המידע האמיתי.
9. **`step1/stage:0` = פנייה חדשה טרם עיבוד**, `step4/stage:3` = בטיפול, `stepQuote/stage:99` = הצעה נשלחה. זו יכולה להיות מפתח לקבוע אילו tasks "בשלים" לפתיחת TaskField.
10. **אין קשר ישיר בין Task ל-Quote** — אין FK. Quote מקושר ל-customer/lead, לא ל-Task ישירות. חיבור עקיף דרך customerId.

## הכלל שגזרתי — מה מבחין תהליך שטח מ-non-field

**FIELD_PROCESS_CANDIDATE** (סבירות גבוהה שיוליד TaskField בעתיד):
- `Task.productName` מתחזה ל-`InspectionType.code` (isFieldInspection=true — תמיד).
- **וגם** יש `customerId` אמיתי (לא draft).
- **וגם** `status = OPEN` (לא CANCELLED).

כרגע 15 מתוך 42 מתאימים לתנאי הזה.

**NEEDS_CONTEXT** (לא ברור):
- draft cards ("כרטיס לקוח חדש" עם 0 שדות).
- productName קיים אך לא מתחזה ל-InspectionType (`10096`, `10098`, `10168`) — אולי מוצרי ייעוץ/דוח שאינם דורשים ביקור, אולי קודים ישנים שהוסרו מהקטלוג.
- ליד חדש עם customer אבל בלי productName עדיין.

**EXCLUDED**:
- CANCELLED (12 שורות).
- Test/demo markers ב-title או customer (3 שורות: 2 test + 1 demo).

**NON_FIELD_TASK**: **0 שורות** בדאטה הנוכחית.
- אין אף Task שהוא באופן ברור "משימה משרדית". טבלת Task ב-CRM הזה נראית כתהליכי לקוח בלבד — לא todo list כללי.
- טיפוסי משימה משרדית ("שלח מייל", "התקשר ליבגני") **לא קיימים ב-Task**. הם קיימים ב-Outlook של יורם אבל לא ב-CRM.

---
*end of report*