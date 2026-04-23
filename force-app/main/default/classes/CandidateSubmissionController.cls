public with sharing class CandidateSubmissionController {

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Get initial context data AND submission template stages
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static InitData getInitialData(Id recordId, String objectName) {
        InitData data = new InitData();

        if (recordId != null && String.isBlank(objectName)) {
            objectName = recordId.getSObjectType().getDescribe().getName();
        }

        Id jobId = null;

        if (objectName == 'Contact') {
            data.candidateId = recordId;
            List<Contact> contacts = [SELECT AccountId FROM Contact WHERE Id = :recordId LIMIT 1];
            if (contacts.isEmpty()) {
                throw new AuraHandledException('Invalid Contact ID or Contact does not exist.');
            }
            data.accountId = contacts[0].AccountId;

        } else if (objectName == 'Job_Applicant__c') {
            data.jobApplicantId = recordId;
            List<Job_Applicant__c> applicants = [
                SELECT Candidate__c, Account__c, Job__c
                FROM Job_Applicant__c
                WHERE Id = :recordId
                LIMIT 1
            ];
            if (applicants.isEmpty()) {
                throw new AuraHandledException('Job Applicant record not found.');
            }
            if (applicants[0].Candidate__c == null) {
                throw new AuraHandledException('Job Applicant is missing required Candidate (Contact) lookup.');
            }
            data.candidateId = applicants[0].Candidate__c;
            data.accountId   = applicants[0].Account__c;
            jobId            = applicants[0].Job__c;

        } else {
            throw new AuraHandledException(
                'Unsupported object type: ' + objectName + '. Must be Contact or Job_Applicant__c.'
            );
        }

        if (jobId != null) {
            data.submissionStages = getSubmissionTemplateStages(jobId);
        } else {
            data.submissionStages = getDefaultStages();
        }

        return data;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1a. Get submission template stages from Job
    // ─────────────────────────────────────────────────────────────────────────
    private static List<SubmissionStageWrapper> getSubmissionTemplateStages(Id jobId) {
        List<SubmissionStageWrapper> stages = new List<SubmissionStageWrapper>();

        List<Candidate_Submission__c> templates = [
            SELECT Stage_Key__c, Stage_Index__c, Is_Required__c, Is_Active__c
            FROM Candidate_Submission__c
            WHERE Job__c = :jobId AND Is_Active__c = true
            ORDER BY Stage_Index__c ASC
        ];

        if (templates.isEmpty()) {
            return getDefaultStages();
        }

        for (Candidate_Submission__c template : templates) {
            SubmissionStageWrapper stage = new SubmissionStageWrapper();
            stage.stageKey   = template.Stage_Key__c;
            stage.stageIndex = Integer.valueOf(template.Stage_Index__c);
            stage.isRequired = template.Is_Required__c;
            stage.isActive   = template.Is_Active__c;
            stage.label      = getLabelForStageKey(template.Stage_Key__c);
            stage.iconName   = getIconForStageKey(template.Stage_Key__c);
            stages.add(stage);
        }

        return stages;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1b. Default stages fallback
    // ─────────────────────────────────────────────────────────────────────────
    private static List<SubmissionStageWrapper> getDefaultStages() {
        List<SubmissionStageWrapper> stages = new List<SubmissionStageWrapper>();

        String[] defaultStageKeys = new String[]{
            'Resume', 'References', 'BLS_Card', 'ACLS_Card', 'Credentials', 'Review'
        };

        for (Integer i = 0; i < defaultStageKeys.size(); i++) {
            SubmissionStageWrapper stage = new SubmissionStageWrapper();
            stage.stageKey   = defaultStageKeys[i];
            stage.stageIndex = i + 1;
            stage.isRequired = (stage.stageKey == 'Resume');
            stage.isActive   = true;
            stage.label      = getLabelForStageKey(stage.stageKey);
            stage.iconName   = getIconForStageKey(stage.stageKey);
            stages.add(stage);
        }

        return stages;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers: label / icon maps
    // ─────────────────────────────────────────────────────────────────────────
    private static String getLabelForStageKey(String key) {
        Map<String, String> labelMap = new Map<String, String>{
            'Resume'           => 'Resume',
            'References'       => 'References',
            'BLS_Card'         => 'BLS Card',
            'ACLS_Card'        => 'ACLS Card',
            'Skills_Checklist' => 'Skills Checklist',
            'Credentials'      => 'Credentials',
            'Review'           => 'Review & Submit'
        };
        return labelMap.containsKey(key) ? labelMap.get(key) : key;
    }

    private static String getIconForStageKey(String key) {
        Map<String, String> iconMap = new Map<String, String>{
            'Resume'           => 'utility:user',
            'References'       => 'utility:people',
            'BLS_Card'         => 'utility:note',
            'ACLS_Card'        => 'utility:favorite',
            'Skills_Checklist' => 'utility:checklist',
            'Credentials'      => 'utility:task',
            'Review'           => 'utility:upload'
        };
        return iconMap.containsKey(key) ? iconMap.get(key) : 'utility:settings';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Fetch documents (Files + classic Attachments)
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static List<DocumentWrapper> getCandidateDocuments(Id candidateId, Id jobApplicantId, Id submissionId) {
        List<DocumentWrapper> docs = new List<DocumentWrapper>();

        Set<Id> entityIds = new Set<Id>();
        if (candidateId    != null) entityIds.add(candidateId);
        if (jobApplicantId != null) entityIds.add(jobApplicantId);
        // Draft persistence: also include submission record to fetch generated/intermediate files
        if (submissionId   != null) entityIds.add(submissionId);
        if (entityIds.isEmpty()) return docs;

        // Modern Files
        List<ContentDocumentLink> links = [
            SELECT ContentDocumentId,
                   ContentDocument.Title,
                   ContentDocument.FileExtension,
                   ContentDocument.LatestPublishedVersionId,
                   ContentDocument.ContentSize,
                   ContentDocument.CreatedDate,
                   ContentDocument.LastModifiedDate
            FROM ContentDocumentLink
            WHERE LinkedEntityId IN :entityIds
            ORDER BY ContentDocument.CreatedDate DESC
        ];

        Set<Id> docIds = new Set<Id>();
        for (ContentDocumentLink link : links) {
            if (docIds.contains(link.ContentDocumentId)) continue;
            docIds.add(link.ContentDocumentId);
            DocumentWrapper dw   = new DocumentWrapper();
            dw.contentDocumentId = link.ContentDocumentId;
            dw.sourceType        = 'File';
            dw.title             = link.ContentDocument.Title;
            dw.extension         = link.ContentDocument.FileExtension != null
                                       ? link.ContentDocument.FileExtension.toLowerCase() : '';
            dw.latestVersionId   = link.ContentDocument.LatestPublishedVersionId;
            dw.contentSize       = link.ContentDocument.ContentSize;
            dw.createdDate       = link.ContentDocument.CreatedDate;
            dw.lastModifiedDate  = link.ContentDocument.LastModifiedDate;
            docs.add(dw);
        }

        // Classic Attachments
        List<Attachment> attachments = [
            SELECT Id, Name, ContentType, BodyLength, CreatedDate, LastModifiedDate
            FROM Attachment
            WHERE ParentId IN :entityIds
            ORDER BY CreatedDate DESC
        ];

        for (Attachment att : attachments) {
            DocumentWrapper dw = new DocumentWrapper();
            dw.contentDocumentId = att.Id;
            dw.sourceType        = 'Attachment';

            String attName = att.Name != null ? att.Name : 'Attachment';
            String ext     = '';
            Integer dotIdx = attName.lastIndexOf('.');
            if (dotIdx > 0 && dotIdx < attName.length() - 1) {
                ext     = attName.substring(dotIdx + 1).toLowerCase();
                attName = attName.substring(0, dotIdx);
            } else {
                ext = contentTypeToExtension(att.ContentType);
            }

            dw.title            = attName;
            dw.extension        = ext;
            dw.contentSize      = att.BodyLength;
            dw.createdDate      = att.CreatedDate;
            dw.lastModifiedDate = att.LastModifiedDate;
            docs.add(dw);
        }

        return docs;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2a. Candidate references
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static List<CandidateReferenceWrapper> getCandidateReferences(Id candidateId, Id jobApplicantId) {
        Id resolvedCandidateId = resolveCandidateId(candidateId, jobApplicantId);
        List<CandidateReferenceWrapper> rows = new List<CandidateReferenceWrapper>();
        if (resolvedCandidateId == null) return rows;

        List<Candidate_Reference__c> refs = [
            SELECT Id, Candidate__c,
                   Reference_First_Name__c, Reference_Last_Name__c, Reference_Email__c,
                   Length_Under_Supervision__c,
                   Supervision_Start_Date__c, Supervision_End_Date__c, Under_Supervision_Current__c,
                   Candidate_Position_Title__c,
                   Position_Start_Date__c, Position_End_Date__c, Position_Current__c,
                   Competence_Rating__c, Strengths__c, Challenges__c, Would_Rehire__c, Notes__c,
                   Generated_Reference_File_Id__c,
                   LastModifiedDate
            FROM Candidate_Reference__c
            WHERE Candidate__c = :resolvedCandidateId
            ORDER BY LastModifiedDate DESC
        ];

        for (Candidate_Reference__c rec : refs) {
            CandidateReferenceWrapper row = new CandidateReferenceWrapper();
            row.referenceId              = rec.Id;
            row.candidateId              = rec.Candidate__c;
            row.referenceFirstName       = rec.Reference_First_Name__c;
            row.referenceLastName        = rec.Reference_Last_Name__c;
            row.referenceEmail           = rec.Reference_Email__c;
            row.lengthUnderSupervision   = rec.Length_Under_Supervision__c;
            row.supervisionStartDate     = rec.Supervision_Start_Date__c;
            row.supervisionEndDate       = rec.Supervision_End_Date__c;
            row.underSupervisionCurrent  = rec.Under_Supervision_Current__c;
            row.candidatePositionTitle   = rec.Candidate_Position_Title__c;
            row.positionStartDate        = rec.Position_Start_Date__c;
            row.positionEndDate          = rec.Position_End_Date__c;
            row.positionCurrent          = rec.Position_Current__c;
            row.competenceRating         = rec.Competence_Rating__c;
            row.strengths                = rec.Strengths__c;
            row.challenges               = rec.Challenges__c;
            row.wouldRehire              = rec.Would_Rehire__c;
            row.notes                    = rec.Notes__c;
            row.generatedFileId          = rec.Generated_Reference_File_Id__c;
            rows.add(row);
        }

        return rows;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2b. Generate single reference PDF
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static ReferencePdfResult generateReferencePdf(Id referenceId, Id candidateId) {
        if (referenceId == null) {
            throw new AuraHandledException('Reference record is required.');
        }

        Candidate_Reference__c ref = [
            SELECT Id, Candidate__c,
                   Reference_First_Name__c, Reference_Last_Name__c,
                   Generated_Reference_File_Id__c
            FROM Candidate_Reference__c
            WHERE Id = :referenceId
            LIMIT 1
        ];

        Id resolvedCandidateId = candidateId != null ? candidateId : ref.Candidate__c;
        if (resolvedCandidateId == null) {
            throw new AuraHandledException('Candidate lookup is required on the reference record.');
        }

        String first    = String.isBlank(ref.Reference_First_Name__c) ? 'Reference' : ref.Reference_First_Name__c;
        String last     = String.isBlank(ref.Reference_Last_Name__c) ? '' : ref.Reference_Last_Name__c;
        String baseName = 'Reference_' + sanitizeFileName((first + '_' + last).trim());
        if (String.isBlank(baseName) || baseName == 'Reference_') baseName = 'Reference_Record';

        if (String.isNotBlank(ref.Generated_Reference_File_Id__c)) {
            try {
                Id existingFileId          = (Id) ref.Generated_Reference_File_Id__c;
                ReferencePdfResult reused  = new ReferencePdfResult();
                reused.referenceId         = referenceId;
                reused.contentDocumentId   = existingFileId;
                reused.fileName            = baseName + '.pdf';
                return reused;
            } catch (Exception ex) {
                // fall through to regenerate
            }
        }

        Blob pdfBlob;
        if (Test.isRunningTest()) {
            pdfBlob = Blob.valueOf('Reference PDF Test Content');
        } else {
            PageReference pdfPage = Page.CandidateReferencePdf;
            pdfPage.getParameters().put('id', String.valueOf(referenceId));
            pdfBlob = pdfPage.getContentAsPDF();
        }

        ContentVersion cv = new ContentVersion();
        cv.Title          = baseName;
        cv.PathOnClient   = baseName + '.pdf';
        cv.VersionData    = pdfBlob;
        cv.IsMajorVersion = true;
        insert cv;

        ContentVersion inserted = [
            SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id LIMIT 1
        ];

        ContentDocumentLink cdl   = new ContentDocumentLink();
        cdl.ContentDocumentId     = inserted.ContentDocumentId;
        cdl.LinkedEntityId        = resolvedCandidateId;
        cdl.ShareType             = 'V';
        cdl.Visibility            = 'AllUsers';
        insert cdl;

        ref.Generated_Reference_File_Id__c = String.valueOf(inserted.ContentDocumentId);
        update ref;

        ReferencePdfResult result  = new ReferencePdfResult();
        result.referenceId         = referenceId;
        result.contentDocumentId   = inserted.ContentDocumentId;
        result.fileName            = baseName + '.pdf';
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2b. Combined reference PDF (Stateful)
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Map<String, String> generateCombinedReferencePdf(List<Id> referenceIds, Id contactId, Id submissionId) {
        if (referenceIds == null || referenceIds.isEmpty()) {
            throw new AuraHandledException('No references selected.');
        }
        try {
            PageReference pdfPage = Page.CandidateReferencePdf;
            pdfPage.getParameters().put('ids', String.join(referenceIds, ','));

            Blob pdfBlob;
            if (Test.isRunningTest()) {
                pdfBlob = Blob.valueOf('Mock Combined Reference PDF Content');
            } else {
                pdfBlob = pdfPage.getContentAsPDF();
            }

            // ── Draft persistence: when submissionId is provided, store as Attachment
            //    on the Candidate_Submission__c record instead of ContentVersion on Contact
            if (submissionId != null) {
                Attachment att   = new Attachment();
                att.ParentId     = submissionId;
                att.Name         = 'Combined_References_Summary.pdf';
                att.ContentType  = 'application/pdf';
                att.Body         = pdfBlob;
                insert att;

                Map<String, String> result = new Map<String, String>();
                result.put('fileName', att.Name);
                result.put('contentDocumentId', att.Id); // Attachment ID (00P prefix)
                return result;
            }

            // ── Original flow: store as ContentVersion linked to Contact ──
            ContentVersion cv = new ContentVersion();
            cv.Title = 'Combined_References_Summary.pdf';
            cv.PathOnClient = 'Combined_References_Summary.pdf';
            cv.VersionData = pdfBlob;
            cv.IsMajorVersion = true;
            insert cv;

            ContentVersion inserted = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id LIMIT 1];

            ContentDocumentLink cdl = new ContentDocumentLink();
            cdl.ContentDocumentId = inserted.ContentDocumentId;
            cdl.LinkedEntityId = contactId;
            cdl.ShareType = 'V';
            cdl.Visibility = 'AllUsers';
            insert cdl;

            Map<String, String> result = new Map<String, String>();
            result.put('fileName', cv.Title);
            result.put('contentDocumentId', inserted.ContentDocumentId);
            return result;
        } catch (Exception e) {
            throw new AuraHandledException('Error generating combined reference PDF: ' + e.getMessage());
        }
    }


    // ─────────────────────────────────────────────────────────────────────────
    // 3. Manual file upload via base64
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static String uploadFile(
        String base64Data,
        String filename,
        String contentType,
        Id recordId
    ) {
        try {
            if (String.isBlank(base64Data) || String.isBlank(filename) || recordId == null) {
                throw new AuraHandledException('Invalid upload parameters.');
            }
            Attachment att = new Attachment();
            att.ParentId    = recordId;
            att.Name        = filename;
            att.ContentType = contentType;
            att.Body        = EncodingUtil.base64Decode(base64Data);
            insert att;
            return att.Id;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('Upload failed: ' + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3a. Inline preview attachment
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static String createInlinePreviewAttachment(Id sourceDocId, Id recordId) {
        try {
            if (sourceDocId == null) throw new AuraHandledException('Source document is required.');
            String prefix = ((String) sourceDocId).substring(0, 3);
            if (prefix == '00P') return (String) sourceDocId;
            if (prefix != '069') throw new AuraHandledException('Unsupported source document type for inline preview.');
            if (recordId == null) throw new AuraHandledException('Record ID is required for preview generation.');

            List<ContentVersion> versionRows = [
                SELECT ContentDocumentId, Title, FileExtension, VersionData
                FROM ContentVersion
                WHERE ContentDocumentId = :sourceDocId AND IsLatest = true
                LIMIT 1
            ];
            if (versionRows.isEmpty()) throw new AuraHandledException('Unable to find latest file version for preview.');

            ContentVersion cv  = versionRows[0];
            String extension   = String.isBlank(cv.FileExtension) ? 'pdf' : cv.FileExtension.toLowerCase();
            String previewName = 'InlinePreview_' + String.valueOf(sourceDocId) + '.' + extension;

            List<Attachment> existing = [
                SELECT Id FROM Attachment WHERE ParentId = :recordId AND Name = :previewName LIMIT 1
            ];
            if (!existing.isEmpty()) return existing[0].Id;

            Attachment att   = new Attachment();
            att.ParentId     = recordId;
            att.Name         = previewName;
            att.ContentType  = extensionToContentType(extension);
            att.Body         = cv.VersionData;
            insert att;
            return att.Id;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('Inline preview generation failed: ' + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Save the Candidate Submission record
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Id saveSubmission(String submissionDataJSON) {
        try {
            Map<String, Object> submissionData =
                (Map<String, Object>) JSON.deserializeUntyped(submissionDataJSON);

            String rawCandidateId = submissionData.get('candidateId') != null
                ? String.valueOf(submissionData.get('candidateId')) : null;
            if (String.isBlank(rawCandidateId)) {
                throw new AuraHandledException(
                    'Candidate ID is required. Please submit from a valid Contact record.'
                );
            }

            // ── Draft persistence: check for existing Draft submission to update ──
            String rawSubmissionId = submissionData.get('submissionId') != null
                ? String.valueOf(submissionData.get('submissionId')) : null;

            Candidate_Submission__c sub;
            Boolean isUpdatingDraft = false;

            if (String.isNotBlank(rawSubmissionId)) {
                // Update existing Draft record instead of creating new
                sub = new Candidate_Submission__c(Id = (Id) rawSubmissionId);
                isUpdatingDraft = true;
                System.debug('saveSubmission — updating existing Draft: ' + rawSubmissionId);
            } else {
                // Legacy fallback: create new record
                sub = new Candidate_Submission__c();
                sub.Candidate__c = (Id) rawCandidateId;
                System.debug('saveSubmission — creating new submission (no draft)');
            }

            sub.Approval_Status__c = 'Submitted to Account manager';
            // Clear the draft state JSON on final submit
            sub.Document_Selection_JSON__c = null;

            if (submissionData.get('jobApplicantId') != null)
                sub.Job_Applicant__c = (Id) String.valueOf(submissionData.get('jobApplicantId'));
            if (submissionData.get('accountId') != null)
                sub.Account__c = (Id) String.valueOf(submissionData.get('accountId'));
            if (submissionData.get('accountManagerId') != null)
                sub.Account_Manager__c = (Id) String.valueOf(submissionData.get('accountManagerId'));

            Map<String, Object> documents   = (Map<String, Object>) submissionData.get('documents');
            String resumeDocId              = (documents != null && documents.get('Resume') != null)
                ? String.valueOf(documents.get('Resume')) : null;
            sub.Has_Resume__c               = String.isNotBlank(resumeDocId);

            Map<String, Object> stageStatus = (Map<String, Object>) submissionData.get('stageStatus');
            sub.References__c       = 'None';
            sub.BLS_Card__c         = false;
            sub.ACLS_Card__c        = false;
            sub.Skills_Checklist__c = false;

            if (stageStatus != null) {
                if (stageStatus.get('References__c') != null)
                    sub.References__c = String.valueOf(stageStatus.get('References__c'));
                sub.BLS_Card__c         = toBoolean(stageStatus.get('BLS_Card__c'));
                sub.ACLS_Card__c        = toBoolean(stageStatus.get('ACLS_Card__c'));
                sub.Skills_Checklist__c = toBoolean(stageStatus.get('Skills_Checklist__c'));
            }

            if (isUpdatingDraft) {
                update sub;
            } else {
                sub.Candidate__c = (Id) rawCandidateId;
                insert sub;
            }

            // ── Draft persistence: clean up ALL intermediate Attachments on submission,
            //    then persist only the final selected files ──────────────────
            Boolean isCombineEnabled = toBoolean(submissionData.get('isCombineEnabled'));
            String mergedAttachmentIdStr = (String) submissionData.get('mergedAttachmentId');

            // FIX: Read the merged attachment BEFORE deleting intermediates
            //      so we preserve its data for re-creation after cleanup.
            Attachment savedMergedAtt = null;
            if (isUpdatingDraft && isCombineEnabled && String.isNotBlank(mergedAttachmentIdStr)) {
                List<Attachment> mergedList = [
                    SELECT Name, ContentType, Body
                    FROM Attachment WHERE Id = :mergedAttachmentIdStr LIMIT 1
                ];
                if (!mergedList.isEmpty()) {
                    savedMergedAtt = mergedList[0];
                }
            }

            // FIX: For combine OFF, read the individual 00P attachments BEFORE deleting
            List<Object> rawDocIds = (List<Object>) submissionData.get('individualDocIds');
            Map<Id, Attachment> savedIndividualAtts = new Map<Id, Attachment>();
            if (isUpdatingDraft && !isCombineEnabled && rawDocIds != null) {
                Set<Id> attIdsToSave = new Set<Id>();
                for (Object o : rawDocIds) {
                    if (o == null) continue;
                    String idStr = String.valueOf(o).trim();
                    if (String.isNotBlank(idStr) && idStr.substring(0, 3) == '00P') {
                        try { attIdsToSave.add((Id) idStr); } catch (Exception ex) { /* skip */ }
                    }
                }
                if (!attIdsToSave.isEmpty()) {
                    for (Attachment src : [
                        SELECT Id, Name, ContentType, Body
                        FROM Attachment WHERE Id IN :attIdsToSave
                    ]) {
                        savedIndividualAtts.put(src.Id, src);
                    }
                }
            }

            if (isUpdatingDraft) {
                // Delete all intermediate Attachments from the draft period
                List<Attachment> intermediates = [
                    SELECT Id FROM Attachment WHERE ParentId = :sub.Id
                ];
                if (!intermediates.isEmpty()) {
                    System.debug('saveSubmission — deleting ' + intermediates.size() + ' intermediate attachments');
                    delete intermediates;
                }
            }

            // ── Attachment strategy: combined vs separate ──────────────────

            System.debug('saveSubmission — isCombineEnabled: ' + isCombineEnabled);

            if (isCombineEnabled) {
                // ── COMBINE ON: re-create the merged attachment from saved data ──
                System.debug('saveSubmission — mergedAttachmentId: ' + mergedAttachmentIdStr);

                if (savedMergedAtt != null) {
                    // Re-create from data we saved before cleanup
                    Attachment clonedAtt  = new Attachment();
                    clonedAtt.ParentId    = sub.Id;
                    clonedAtt.Name        = savedMergedAtt.Name;
                    clonedAtt.ContentType = savedMergedAtt.ContentType;
                    clonedAtt.Body        = savedMergedAtt.Body;
                    insert clonedAtt;
                } else if (String.isNotBlank(mergedAttachmentIdStr)) {
                    // Non-draft flow: attachment still exists (wasn't deleted)
                    List<Attachment> sourceAttList = [
                        SELECT Name, ContentType, Body
                        FROM Attachment WHERE Id = :mergedAttachmentIdStr LIMIT 1
                    ];
                    if (!sourceAttList.isEmpty()) {
                        Attachment clonedAtt  = new Attachment();
                        clonedAtt.ParentId    = sub.Id;
                        clonedAtt.Name        = sourceAttList[0].Name;
                        clonedAtt.ContentType = sourceAttList[0].ContentType;
                        clonedAtt.Body        = sourceAttList[0].Body;
                        insert clonedAtt;
                    }
                }

                // Fallback: base64 merged PDF from LWC
                String mergedPdfBase64 = (String) submissionData.get('mergedPdfBase64');
                if (String.isNotBlank(mergedPdfBase64)) {
                    // Only use if no attachment was cloned above
                    List<Attachment> existing = [
                        SELECT Id FROM Attachment WHERE ParentId = :sub.Id LIMIT 1
                    ];
                    if (existing.isEmpty()) {
                        Attachment att  = new Attachment();
                        att.ParentId    = sub.Id;
                        att.Name        = 'Candidate_Submission_Package.pdf';
                        att.ContentType = 'application/pdf';
                        att.Body        = EncodingUtil.base64Decode(mergedPdfBase64);
                        insert att;
                    }
                }
            } else {
                // ── COMBINE OFF: clone each selected doc individually ───────
                // rawDocIds was already declared above for the pre-save logic

                System.debug('saveSubmission — individualDocIds raw: ' + rawDocIds);

                if (rawDocIds != null && !rawDocIds.isEmpty()) {

                    List<Id> contentDocIds = new List<Id>();
                    List<Id> attachmentIds = new List<Id>();

                    for (Object o : rawDocIds) {
                        if (o == null) continue;
                        String idStr = String.valueOf(o).trim();
                        if (String.isBlank(idStr)) continue;
                        try {
                            Id sfId = (Id) idStr;
                            String prefix = idStr.substring(0, 3);
                            if (prefix == '069') {
                                contentDocIds.add(sfId);
                            } else if (prefix == '00P') {
                                attachmentIds.add(sfId);
                            } else {
                                System.debug('saveSubmission — skipping unknown ID prefix: ' + idStr);
                            }
                        } catch (Exception idEx) {
                            System.debug('saveSubmission — invalid ID skipped: ' + idStr + ' — ' + idEx.getMessage());
                        }
                    }

                    System.debug('saveSubmission — contentDocIds: ' + contentDocIds);
                    System.debug('saveSubmission — attachmentIds: ' + attachmentIds);

                    List<Attachment> attachmentsToInsert = new List<Attachment>();

                    // Modern Files (Contact ContentDocuments) → clone as Attachment on submission
                    if (!contentDocIds.isEmpty()) {
                        Map<Id, ContentVersion> cvMap = new Map<Id, ContentVersion>();
                        for (ContentVersion cv : [
                            SELECT ContentDocumentId, Title, FileExtension, VersionData
                            FROM ContentVersion
                            WHERE ContentDocumentId IN :contentDocIds AND IsLatest = true
                        ]) {
                            cvMap.put(cv.ContentDocumentId, cv);
                        }

                        for (Id docId : contentDocIds) {
                            ContentVersion cv = cvMap.get(docId);
                            if (cv == null) {
                                System.debug('saveSubmission — no ContentVersion found for: ' + docId);
                                continue;
                            }
                            String ext    = String.isBlank(cv.FileExtension)
                                                ? 'pdf' : cv.FileExtension.toLowerCase();
                            Attachment a  = new Attachment();
                            a.ParentId    = sub.Id;
                            a.Name        = cv.Title + '.' + ext;
                            a.ContentType = extensionToContentType(ext);
                            a.Body        = cv.VersionData;
                            attachmentsToInsert.add(a);
                        }
                    }

                    // Submission Attachments (00P) — re-create from saved data (read before cleanup)
                    if (!attachmentIds.isEmpty()) {
                        for (Id attId : attachmentIds) {
                            Attachment src = savedIndividualAtts.get(attId);
                            if (src == null) {
                                // Fallback: try to query (for non-draft flow where delete didn't happen)
                                List<Attachment> fallbackList = [
                                    SELECT Name, ContentType, Body
                                    FROM Attachment WHERE Id = :attId LIMIT 1
                                ];
                                if (!fallbackList.isEmpty()) src = fallbackList[0];
                            }
                            if (src == null) {
                                System.debug('saveSubmission — Attachment not found: ' + attId);
                                continue;
                            }
                            Attachment a  = new Attachment();
                            a.ParentId    = sub.Id;
                            a.Name        = src.Name;
                            a.ContentType = src.ContentType;
                            a.Body        = src.Body;
                            attachmentsToInsert.add(a);
                        }
                    }

                    if (!attachmentsToInsert.isEmpty()) {
                        System.debug('saveSubmission — inserting ' + attachmentsToInsert.size() + ' final attachments');
                        insert attachmentsToInsert;
                    } else {
                        System.debug('saveSubmission — WARNING: no attachments to insert (combine OFF)');
                    }
                } else {
                    System.debug('saveSubmission — WARNING: individualDocIds is null or empty (combine OFF)');
                }
            }

            return sub.Id;

        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage() + ' at line ' + e.getLineNumber());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Return Base64 strings for PDF merge
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Map<Id, String> getDocumentBase64Map(List<Id> docIds) {
        Map<Id, String> base64Map = new Map<Id, String>();
        if (docIds == null || docIds.isEmpty()) return base64Map;

        List<Id> contentDocIds = new List<Id>();
        List<Id> attachmentIds  = new List<Id>();

        for (Id docId : docIds) {
            String prefix = ((String) docId).substring(0, 3);
            if (prefix == '069')      contentDocIds.add(docId);
            else if (prefix == '00P') attachmentIds.add(docId);
        }

        if (!contentDocIds.isEmpty()) {
            for (ContentVersion cv : [
                SELECT ContentDocumentId, VersionData
                FROM ContentVersion
                WHERE ContentDocumentId IN :contentDocIds AND IsLatest = true
            ]) {
                base64Map.put(cv.ContentDocumentId, EncodingUtil.base64Encode(cv.VersionData));
            }
        }

        if (!attachmentIds.isEmpty()) {
            for (Attachment att : [SELECT Id, Body FROM Attachment WHERE Id IN :attachmentIds]) {
                base64Map.put(att.Id, EncodingUtil.base64Encode(att.Body));
            }
        }

        return base64Map;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Server-side PDF merge (kept for fallback)
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static String mergePDFsServerSide(List<Id> docIds, Id candidateId) {
        if (docIds == null || docIds.isEmpty())
            throw new AuraHandledException('No documents selected for merge.');
        if (candidateId == null)
            throw new AuraHandledException('Candidate ID required.');

        try {
            List<Blob> pdfBlobs = new List<Blob>();

            for (Id docId : docIds) {
                String prefix = ((String) docId).substring(0, 3);
                if (prefix == '069') {
                    List<ContentVersion> cvList = [
                        SELECT VersionData, FileExtension
                        FROM ContentVersion
                        WHERE ContentDocumentId = :docId AND IsLatest = true LIMIT 1
                    ];
                    if (!cvList.isEmpty()) {
                        ContentVersion cv = cvList[0];
                        if (cv.FileExtension != null && cv.FileExtension.toLowerCase() == 'pdf')
                            pdfBlobs.add(cv.VersionData);
                    }
                } else if (prefix == '00P') {
                    List<Attachment> attList = [
                        SELECT Body, ContentType, Name FROM Attachment WHERE Id = :docId LIMIT 1
                    ];
                    if (!attList.isEmpty()) {
                        Attachment att = attList[0];
                        Boolean isPdf  = (att.ContentType != null && att.ContentType.toLowerCase().contains('pdf'))
                                      || (att.Name != null && att.Name.toLowerCase().endsWith('.pdf'));
                        if (isPdf) pdfBlobs.add(att.Body);
                    }
                }
            }

            if (pdfBlobs.isEmpty())
                throw new AuraHandledException('No valid PDF documents found to merge.');

            Blob mergedBlob  = pdfBlobs[0];
            String fileName  = pdfBlobs.size() > 1
                ? 'Merged_' + pdfBlobs.size() + 'PDFs_' + System.now().getTime() + '.pdf'
                : 'Merged_PDF_' + System.now().getTime() + '.pdf';

            Attachment tempAtt  = new Attachment();
            tempAtt.ParentId    = candidateId;
            tempAtt.Name        = fileName;
            tempAtt.ContentType = 'application/pdf';
            tempAtt.Body        = mergedBlob;
            insert tempAtt;

            return EncodingUtil.base64Encode(mergedBlob);

        } catch (QueryException e) {
            throw new AuraHandledException('Document query error: ' + e.getMessage());
        } catch (Exception e) {
            throw new AuraHandledException('Merge failed: ' + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Draft Submission Management
    //    Creates or retrieves an existing Draft Candidate_Submission__c record
    //    so that intermediate files can be stored on it from the very first stage.
    //    Duplicate handling: one draft per Candidate + Job Applicant combo.
    //    When no Job Applicant, each entry creates a new draft.
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Map<String, Object> getOrCreateDraftSubmission(Id candidateId, Id jobApplicantId, Id accountId) {
        if (candidateId == null) {
            throw new AuraHandledException('Candidate ID is required to create a draft submission.');
        }

        Map<String, Object> result = new Map<String, Object>();

        // Look for existing draft (not yet submitted) for this candidate + job applicant
        List<Candidate_Submission__c> drafts;
        if (jobApplicantId != null) {
            drafts = [
                SELECT Id, Document_Selection_JSON__c
                FROM Candidate_Submission__c
                WHERE Candidate__c = :candidateId
                  AND Job_Applicant__c = :jobApplicantId
                  AND Approval_Status__c != 'Submitted to Account manager'
                ORDER BY LastModifiedDate DESC
                LIMIT 1
            ];
        } else {
            drafts = [
                SELECT Id, Document_Selection_JSON__c
                FROM Candidate_Submission__c
                WHERE Candidate__c = :candidateId
                  AND Job_Applicant__c = null
                  AND Approval_Status__c != 'Submitted to Account manager'
                ORDER BY LastModifiedDate DESC
                LIMIT 1
            ];
        }

        if (!drafts.isEmpty()) {
            // Return existing draft for restoration
            result.put('submissionId', drafts[0].Id);
            result.put('documentSelectionJson', drafts[0].Document_Selection_JSON__c);
            result.put('isExisting', true);
        } else {
            // Create new Draft submission record (leave Approval_Status__c as default/null)
            Candidate_Submission__c sub = new Candidate_Submission__c();
            sub.Candidate__c       = candidateId;
            if (jobApplicantId != null) sub.Job_Applicant__c = jobApplicantId;
            if (accountId      != null) sub.Account__c       = accountId;
            insert sub;

            result.put('submissionId', sub.Id);
            result.put('documentSelectionJson', null);
            result.put('isExisting', false);
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7a. Persist draft state (document selections, stage status, current stage)
    //     Called on every stage change / document selection to preserve progress.
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void saveDraftState(Id submissionId, String documentSelectionJson) {
        if (submissionId == null) return;
        Candidate_Submission__c sub = new Candidate_Submission__c(Id = submissionId);
        sub.Document_Selection_JSON__c = documentSelectionJson;
        update sub;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7b. Generate resume PDF and store as Attachment on Submission record.
    //     This avoids polluting the Contact with intermediate files.
    //     Uses the same VF page as ResumeGeneratorController.saveResumeAsPDF
    //     but targets the submission record instead of Contact.
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Map<String, String> generateResumePdfForSubmission(
        Id contactId, Id submissionId, String candidateName, String templateId
    ) {
        if (contactId == null || submissionId == null) {
            throw new AuraHandledException('Contact ID and Submission ID are required.');
        }
        try {
            String tmplId = String.isNotBlank(templateId) ? templateId : 'ResumeTemplateCleanPDF';

            PageReference pdfPage = Page.Resumepdfgenerator;
            pdfPage.getParameters().put('contactId',  String.valueOf(contactId));
            pdfPage.getParameters().put('templateId', tmplId);

            Blob pdfBlob;
            if (Test.isRunningTest()) {
                pdfBlob = Blob.valueOf('TEST RESUME PDF');
            } else {
                pdfBlob = pdfPage.getContentAsPDF();
            }

            String safeName = String.isNotBlank(candidateName)
                ? candidateName.replaceAll('[^a-zA-Z0-9 _-]', '').replaceAll(' ', '_')
                : 'Candidate';
            String fileName = 'Resume_' + safeName + '_' + System.now().format('yyyyMMdd_HHmmss') + '.pdf';

            // Store as Attachment on the Candidate_Submission__c record (Notes & Attachments)
            Attachment att   = new Attachment();
            att.ParentId     = submissionId;
            att.Name         = fileName;
            att.ContentType  = 'application/pdf';
            att.Body         = pdfBlob;
            insert att;

            Map<String, String> res = new Map<String, String>();
            res.put('attachmentId', att.Id);
            res.put('fileName',     fileName);
            return res;
        } catch (Exception e) {
            throw new AuraHandledException('Resume PDF generation failed: ' + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7c. Clean up intermediate Attachments on submission record.
    //     Called during final submit to remove generated intermediate files,
    //     keeping only the final selected files.
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void cleanupIntermediateAttachments(Id submissionId, List<String> keepAttachmentIds) {
        if (submissionId == null) return;

        Set<Id> keepIds = new Set<Id>();
        if (keepAttachmentIds != null) {
            for (String idStr : keepAttachmentIds) {
                if (String.isNotBlank(idStr)) {
                    try { keepIds.add((Id) idStr.trim()); } catch (Exception ex) { /* skip invalid */ }
                }
            }
        }

        List<Attachment> toDelete = [
            SELECT Id FROM Attachment
            WHERE ParentId = :submissionId
              AND Id NOT IN :keepIds
        ];
        if (!toDelete.isEmpty()) {
            delete toDelete;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wrapper Classes
    // ─────────────────────────────────────────────────────────────────────────
    public class InitData {
        @AuraEnabled public Id candidateId;
        @AuraEnabled public Id jobApplicantId;
        @AuraEnabled public Id accountId;
        @AuraEnabled public List<SubmissionStageWrapper> submissionStages;
    }

    public class SubmissionStageWrapper {
        @AuraEnabled public String  stageKey;
        @AuraEnabled public String  label;
        @AuraEnabled public Integer stageIndex;
        @AuraEnabled public Boolean isRequired;
        @AuraEnabled public Boolean isActive;
        @AuraEnabled public String  iconName;
    }

    public class DocumentWrapper {
        @AuraEnabled public Id       contentDocumentId;
        @AuraEnabled public String   sourceType;
        @AuraEnabled public String   title;
        @AuraEnabled public String   extension;
        @AuraEnabled public Id       latestVersionId;
        @AuraEnabled public Integer  contentSize;
        @AuraEnabled public DateTime createdDate;
        @AuraEnabled public DateTime lastModifiedDate;
    }

    public class CandidateReferenceWrapper {
        @AuraEnabled public Id      referenceId;
        @AuraEnabled public Id      candidateId;
        @AuraEnabled public String  referenceFirstName;
        @AuraEnabled public String  referenceLastName;
        @AuraEnabled public String  referenceEmail;
        @AuraEnabled public String  lengthUnderSupervision;
        @AuraEnabled public Date    supervisionStartDate;
        @AuraEnabled public Date    supervisionEndDate;
        @AuraEnabled public Boolean underSupervisionCurrent;
        @AuraEnabled public String  candidatePositionTitle;
        @AuraEnabled public Date    positionStartDate;
        @AuraEnabled public Date    positionEndDate;
        @AuraEnabled public Boolean positionCurrent;
        @AuraEnabled public String  competenceRating;
        @AuraEnabled public String  strengths;
        @AuraEnabled public String  challenges;
        @AuraEnabled public String  wouldRehire;
        @AuraEnabled public String  notes;
        @AuraEnabled public String  generatedFileId;
    }

    public class ReferencePdfResult {
        @AuraEnabled public Id     referenceId;
        @AuraEnabled public Id     contentDocumentId;
        @AuraEnabled public String fileName;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────
    private static Boolean toBoolean(Object rawValue) {
        if (rawValue == null)            return false;
        if (rawValue instanceof Boolean) return (Boolean) rawValue;
        return String.valueOf(rawValue).toLowerCase() == 'true';
    }

    private static String contentTypeToExtension(String ct) {
        if (String.isBlank(ct)) return '';
        ct = ct.toLowerCase();
        if (ct.contains('pdf'))                        return 'pdf';
        if (ct.contains('png'))                        return 'png';
        if (ct.contains('jpeg') || ct.contains('jpg')) return 'jpg';
        if (ct.contains('gif'))                        return 'gif';
        if (ct.contains('word')  || ct.contains('docx')) return 'docx';
        if (ct.contains('excel') || ct.contains('xlsx')) return 'xlsx';
        if (ct.contains('plain'))                      return 'txt';
        return '';
    }

    private static String extensionToContentType(String ext) {
        if (String.isBlank(ext)) return 'application/octet-stream';
        ext = ext.toLowerCase();
        if (ext == 'pdf')                  return 'application/pdf';
        if (ext == 'png')                  return 'image/png';
        if (ext == 'jpg' || ext == 'jpeg') return 'image/jpeg';
        if (ext == 'gif')                  return 'image/gif';
        if (ext == 'doc')                  return 'application/msword';
        if (ext == 'docx')                 return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (ext == 'txt')                  return 'text/plain';
        return 'application/octet-stream';
    }

    private static Id resolveCandidateId(Id candidateId, Id jobApplicantId) {
        if (candidateId != null)    return candidateId;
        if (jobApplicantId == null) return null;
        List<Job_Applicant__c> applicants = [
            SELECT Candidate__c FROM Job_Applicant__c WHERE Id = :jobApplicantId LIMIT 1
        ];
        return applicants.isEmpty() ? null : applicants[0].Candidate__c;
    }

    private static String sanitizeFileName(String raw) {
        if (String.isBlank(raw)) return '';
        String cleaned = raw.replaceAll('[^a-zA-Z0-9 _-]', '_').trim();
        while (cleaned.contains('__')) cleaned = cleaned.replace('__', '_');
        return cleaned;
    }
}