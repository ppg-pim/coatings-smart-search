import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

type ProductRecord = Record<string, any>

// Enhanced HTML stripping with comprehensive entity handling
function stripHtml(html: string): string {
  if (typeof html !== 'string') return html
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&deg;/g, '°')
    .replace(/&reg;/g, '®')
    .replace(/&copy;/g, '©')
    .replace(/&trade;/g, '™')
    .replace(/&euro;/g, '€')
    .replace(/&pound;/g, '£')
    .replace(/&yen;/g, '¥')
    .replace(/&cent;/g, '¢')
    .replace(/&sect;/g, '§')
    .replace(/&para;/g, '¶')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')
    .replace(/&hellip;/g, '…')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&times;/g, '×')
    .replace(/&divide;/g, '÷')
    .replace(/&plusmn;/g, '±')
    .replace(/&frac14;/g, '¼')
    .replace(/&frac12;/g, '½')
    .replace(/&frac34;/g, '¾')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (match, entity) => {
      const entities: Record<string, string> = {
        'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'",
        'deg': '°', 'reg': '®', 'copy': '©', 'trade': '™', 'euro': '€', 'pound': '£',
        'yen': '¥', 'cent': '¢', 'sect': '§', 'para': '¶', 'middot': '·', 'bull': '•',
        'hellip': '…', 'ndash': '–', 'mdash': '—', 'lsquo': '\u2018', 'rsquo': '\u2019',
        'ldquo': '\u201C', 'rdquo': '\u201D', 'times': '×', 'divide': '÷', 'plusmn': '±',
        'frac14': '¼', 'frac12': '½', 'frac34': '¾',
      }
      return entities[entity.toLowerCase()] || match
    })
    .trim()
}

// Helper function to clean and flatten product data
function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}
  const seen = new Set<string>()
  
  const excludeFields = ['embedding', 'all_attributes']
  
  Object.keys(product).forEach(key => {
    const lowerKey = key.toLowerCase()
    
    if (seen.has(lowerKey) || excludeFields.includes(key)) return
    seen.add(lowerKey)
    
    const value = product[key]
    
    if (value === null || value === undefined || value === '') return
    
    if (typeof value === 'string') {
      const cleanedValue = stripHtml(value)
      if (cleanedValue) {
        cleaned[key] = cleanedValue
      }
    } else {
      cleaned[key] = value
    }
  })
  
  if (product.all_attributes) {
    try {
      let attributes: ProductRecord = {}
      
      if (typeof product.all_attributes === 'string') {
        attributes = JSON.parse(product.all_attributes)
      } else if (typeof product.all_attributes === 'object') {
        attributes = product.all_attributes
      }
      
      Object.keys(attributes).forEach(key => {
        const lowerKey = key.toLowerCase()
        
        if (seen.has(lowerKey)) return
        seen.add(lowerKey)
        
        const value = attributes[key]
        
        if (value === null || value === undefined || value === '') return
        
        if (typeof value === 'string') {
          const cleanedValue = stripHtml(value)
          if (cleanedValue) {
            cleaned[key] = cleanedValue
          }
        } else {
          cleaned[key] = value
        }
      })
    } catch (e) {
      console.error('Error parsing all_attributes:', e)
    }
  }
  
  return cleaned
}

// Helper to truncate product data for AI processing
function truncateProductForAI(product: ProductRecord, maxLength: number = 8000): string {
  let result = JSON.stringify(product, null, 2)
  
  if (result.length > maxLength) {
    const priorityFields = ['sku', 'product_name', 'name', 'description', 'color', 'colour']
    const truncated: ProductRecord = {}
    
    priorityFields.forEach(field => {
      if (product[field]) {
        truncated[field] = product[field]
      }
    })
    
    Object.keys(product).forEach(key => {
      if (!priorityFields.includes(key)) {
        const testResult = JSON.stringify({ ...truncated, [key]: product[key] })
        if (testResult.length < maxLength) {
          truncated[key] = product[key]
        }
      }
    })
    
    result = JSON.stringify(truncated, null, 2)
  }
  
  return result
}

// Helper function to build query string for OR conditions
function buildOrConditions(filters: any[], columns: string[]): string | null {
  const orConditions = filters
    .map((filter: any) => {
      const { column, operator, value } = filter
      
      if (!columns.includes(column)) {
        console.warn(`Column "${column}" not found`)
        return null
      }
      
      switch (operator) {
        case 'eq':
          return `${column}.eq.${value}`
        case 'ilike':
          return `${column}.ilike.${value}`
        case 'gt':
          return `${column}.gt.${value}`
        case 'lt':
          return `${column}.lt.${value}`
        case 'gte':
          return `${column}.gte.${value}`
        case 'lte':
          return `${column}.lte.${value}`
        default:
          return null
      }
    })
    .filter(Boolean)
  
  return orConditions.length > 0 ? orConditions.join(',') : null
}

// Helper to apply user filters with flexible column matching
function applyUserFilters(dbQuery: any, filters: any, columns: string[], allProducts: any[]) {
  if (!filters) return dbQuery

  // For family filter
  if (filters.family) {
    const familyColumns = ['family', 'Family', 'product_family', 'productFamily'].filter(col => columns.includes(col))
    
    if (familyColumns.length > 0) {
      dbQuery = dbQuery.eq(familyColumns[0], filters.family)
      console.log(`🎯 Applied family filter on column "${familyColumns[0]}": ${filters.family}`)
    } else {
      console.log(`⚠️ Family column not found in DB, will filter in memory`)
    }
  }

  // For product type filter
  if (filters.productType) {
    const typeColumns = ['product_type', 'productType', 'type', 'Type', 'category', 'Category'].filter(col => columns.includes(col))
    
    if (typeColumns.length > 0) {
      dbQuery = dbQuery.eq(typeColumns[0], filters.productType)
      console.log(`🎯 Applied product type filter on column "${typeColumns[0]}": ${filters.productType}`)
    } else {
      console.log(`⚠️ Product type column not found in DB, will filter in memory`)
    }
  }

  // For product model filter (changed from specification)
  if (filters.productModel) {
    const modelColumns = ['product_model', 'productModel', 'model', 'Model'].filter(col => columns.includes(col))
    
    if (modelColumns.length > 0) {
      dbQuery = dbQuery.eq(modelColumns[0], filters.productModel)
      console.log(`🎯 Applied product model filter on column "${modelColumns[0]}": ${filters.productModel}`)
    } else {
      console.log(`⚠️ Product model column not found in DB, will filter in memory`)
    }
  }

  return dbQuery
}

// Helper to filter products in memory (fallback when DB columns don't exist)
function filterProductsInMemory(products: any[], filters: any): any[] {
  if (!filters) return products

  return products.filter(product => {
    let matches = true

    // Check family
    if (filters.family) {
      const familyValue = product.family || product.Family || product.product_family || product.productFamily
      const attrFamily = product.all_attributes?.family || product.all_attributes?.Family
      
      if (familyValue !== filters.family && attrFamily !== filters.family) {
        matches = false
      }
    }

    // Check product type
    if (filters.productType) {
      const typeValue = product.product_type || product.productType || product.type || product.Type || product.category || product.Category
      const attrType = product.all_attributes?.product_type || product.all_attributes?.type
      
      if (typeValue !== filters.productType && attrType !== filters.productType) {
        matches = false
      }
    }

    // Check product model (changed from specification)
    if (filters.productModel) {
      const modelValue = product.product_model || product.productModel || product.model || product.Model
      const attrModel = product.all_attributes?.product_model || product.all_attributes?.model
      
      if (modelValue !== filters.productModel && attrModel !== filters.productModel) {
        matches = false
      }
    }

    return matches
  })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { query, filters, getFilterOptions } = body

    // Handle filter options request
    if (query === '__GET_FILTER_OPTIONS__' || getFilterOptions === true) {
      console.log('📋 Loading filter options...')
      
      try {
        const { data: coatings, error } = await supabase
          .from('coatings')
          .select('*')
          .limit(10000)

        if (error) {
          throw new Error(`Database error: ${error.message}`)
        }

        const families = new Set<string>()
        const productTypes = new Set<string>()
        const productModels = new Set<string>()

        coatings?.forEach((coating: any) => {
          // Extract family
          const familyValue = coating.family || coating.Family || coating.product_family || coating.productFamily
          if (familyValue && String(familyValue).trim()) {
            families.add(String(familyValue).trim())
          }

          // Extract product type
          const typeValue = coating.product_type || coating.productType || coating.type || coating.Type || coating.category || coating.Category
          if (typeValue && String(typeValue).trim()) {
            productTypes.add(String(typeValue).trim())
          }

          // Extract product model (changed from specification)
          const modelValue = coating.product_model || coating.productModel || coating.model || coating.Model
          if (modelValue && String(modelValue).trim()) {
            productModels.add(String(modelValue).trim())
          }

          // Also check in all_attributes
          if (coating.all_attributes) {
            try {
              let attributes: any = typeof coating.all_attributes === 'string' 
                ? JSON.parse(coating.all_attributes) 
                : coating.all_attributes

              const attrFamily = attributes.family || attributes.Family || attributes.product_family || attributes.productFamily
              if (attrFamily && String(attrFamily).trim()) {
                families.add(String(attrFamily).trim())
              }

              const attrType = attributes.product_type || attributes.productType || attributes.type || attributes.Type
              if (attrType && String(attrType).trim()) {
                productTypes.add(String(attrType).trim())
              }

              const attrModel = attributes.product_model || attributes.productModel || attributes.model || attributes.Model
              if (attrModel && String(attrModel).trim()) {
                productModels.add(String(attrModel).trim())
              }
            } catch (e) {
              // Ignore parsing errors
            }
          }
        })

        const familiesArray = Array.from(families).sort()
        const productTypesArray = Array.from(productTypes).sort()
        const productModelsArray = Array.from(productModels).sort()

        console.log(`✅ Filter options loaded: ${familiesArray.length} families, ${productTypesArray.length} types, ${productModelsArray.length} models`)

        return NextResponse.json({
          success: true,
          filterOptions: {
            families: familiesArray,
            productTypes: productTypesArray,
            productModels: productModelsArray
          }
        })
      } catch (error: any) {
        console.error('❌ Error loading filter options:', error)
        return NextResponse.json({
          success: false,
          filterOptions: { 
            families: [], 
            productTypes: [], 
            productModels: [] 
          },
          error: error.message
        })
      }
    }

    // Regular search flow continues below
    if (!query) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      )
    }

    console.log('🔍 User query:', query)
    console.log('🎯 Applied filters:', filters)

    // Step 1: Get table schema with sample data
    const { data: sampleData, error: schemaError } = await supabase
      .from('coatings')
      .select('*')
      .limit(3)

    if (schemaError) {
      throw new Error(`Schema error: ${schemaError.message}`)
    }

    const columns = sampleData && sampleData.length > 0 
      ? Object.keys(sampleData[0]) 
      : []

    const samplePreview = sampleData?.slice(0, 2).map((item: ProductRecord) => {
      const preview: ProductRecord = {}
      Object.keys(item).forEach(key => {
        const value = item[key]
        if (typeof value === 'string' && value.length > 100) {
          preview[key] = value.substring(0, 100) + '...'
        } else {
          preview[key] = value
        }
      })
      return preview
    })

    console.log('📊 Available columns:', columns.length)

    // Step 2: Use GPT-4o-mini to understand the query
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a smart database search assistant for coatings products. Analyze user queries and generate appropriate database filters.

DATABASE SCHEMA:
Columns: ${columns.join(', ')}

SAMPLE DATA STRUCTURE:
${JSON.stringify(samplePreview, null, 2)}

USER APPLIED FILTERS:
${filters ? JSON.stringify(filters, null, 2) : 'None'}

IMPORTANT NOTES:
- The "searchable_text" column contains ALL product information (flattened from all_attributes)
- Product identifiers can be in "sku", "product_name", or "name" columns
- Use BROAD searches with "ilike" and wildcards for maximum accuracy
- Products may have variants (e.g., different models or classes)
- When user asks for a product family, show ALL variants
- If user has applied filters (family, productType, productModel), incorporate them into the search

SEARCH STRATEGY FOR HIGH ACCURACY:

1. **SINGLE PRODUCT QUERY** (e.g., product names or SKUs):
 - Set questionType: "list"
 - Search broadly with wildcards to match variations
 - Search in: sku, product_name, name, searchable_text
 - Use "any" searchType to find ALL variants
 - Set limit: null (to show all variants)

2. **COMPARISON QUERIES** ("difference", "compare", "vs", "versus", "between"):
 - Set questionType: "comparison"
 - Extract product identifiers
 - Create filters for EACH product with wildcards
 - Search in: sku, product_name, name, searchable_text
 - Use "any" searchType (OR logic)
 - Set limit: null

3. **ATTRIBUTE QUESTIONS** ("what is the [attribute] of [product]"):
 - Set questionType: "specific_ai"
 - Search broadly for product identifier
 - Let AI extract the specific attribute from results
 - Set limit: 5

4. **EXACT SKU LOOKUP**:
 - Use "eq" operator only if SKU format is exact
 - Otherwise use "ilike" with wildcards

RESPONSE FORMAT (JSON):
{
"filters": [
  {
    "column": "column_name",
    "operator": "eq" | "ilike",
    "value": "value"
  }
],
"searchType": "all" | "any",
"questionType": "list" | "specific_ai" | "comparison",
"attributeQuestion": "extracted question",
"compareProducts": ["product1", "product2"],
"limit": null | number
}

CRITICAL RULES:
- For single product queries, use "list" questionType and limit: null to show ALL variants
- For comparisons, ALWAYS use "any" searchType and limit: null
- Use wildcards liberally for better matches
- Search multiple columns (sku, product_name, name, searchable_text) for better matches
- When user asks for product family, return ALL related products`
        },
        {
          role: 'user',
          content: query
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 2000
    })

    let searchParams
    try {
      searchParams = JSON.parse(completion.choices[0].message.content || '{"filters": [], "searchType": "any", "questionType": "list", "limit": null}')
    } catch (parseError) {
      console.error('❌ Failed to parse GPT response:', completion.choices[0].message.content)
      searchParams = { filters: [], searchType: "any", questionType: "list", limit: null }
    }

    console.log('📋 Parsed search params:', JSON.stringify(searchParams, null, 2))

    if (!searchParams.filters || !Array.isArray(searchParams.filters)) {
      searchParams.filters = []
    }
    if (!searchParams.searchType) {
      searchParams.searchType = "any"
    }
    if (!searchParams.questionType) {
      searchParams.questionType = "list"
    }

    // Step 3: Build Supabase query
    let dbQuery: any = supabase.from('coatings').select('*')

    // Apply user-selected filters
    dbQuery = applyUserFilters(dbQuery, filters, columns, [])

    if (searchParams.filters.length > 0) {
      console.log(`🔍 Applying ${searchParams.filters.length} filters with ${searchParams.searchType} logic`)
      
      if (searchParams.searchType === "any") {
        const orConditionString = buildOrConditions(searchParams.filters, columns)
        
        if (orConditionString) {
          dbQuery = dbQuery.or(orConditionString)
          console.log('✅ OR conditions applied')
        }
      } else {
        const validFilters = searchParams.filters.filter((filter: any) => 
          columns.includes(filter.column)
        )
        
        console.log(`✅ Valid filters: ${validFilters.length}/${searchParams.filters.length}`)
        
        for (const filter of validFilters) {
          const { column, operator, value } = filter
          console.log(`  → ${column} ${operator} ${value}`)
          
          switch (operator) {
            case 'eq':
              dbQuery = dbQuery.eq(column, value)
              break
            case 'ilike':
              dbQuery = dbQuery.ilike(column, value)
              break
            case 'gt':
              dbQuery = dbQuery.gt(column, value)
              break
            case 'lt':
              dbQuery = dbQuery.lt(column, value)
              break
            case 'gte':
              dbQuery = dbQuery.gte(column, value)
              break
            case 'lte':
              dbQuery = dbQuery.lte(column, value)
              break
          }
        }
      }
    } else {
      console.log('📦 No search filters - will return filtered by user selections')
    }

    if (searchParams.orderBy?.column && columns.includes(searchParams.orderBy.column)) {
      console.log(`📊 Ordering by: ${searchParams.orderBy.column}`)
      dbQuery = dbQuery.order(
        searchParams.orderBy.column,
        { ascending: searchParams.orderBy.ascending ?? true }
      )
    }

    const limit = searchParams.limit !== undefined && searchParams.limit !== null 
      ? searchParams.limit 
      : 1000
    
    if (limit > 0) {
      dbQuery = dbQuery.limit(limit)
      console.log(`🔢 Applying limit: ${limit}`)
    }

    let { data, error } = await dbQuery

    if (error) {
      console.error('❌ Supabase error:', error)
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`✅ Query returned ${data?.length || 0} results`)

    // Apply in-memory filtering if needed
    if (data && data.length > 0 && filters) {
      const beforeFilter = data.length
      data = filterProductsInMemory(data, filters)
      console.log(`🔄 In-memory filter: ${beforeFilter} → ${data.length} products`)
    }

    // FALLBACK: If no results, try simpler search
    if ((!data || data.length === 0) && searchParams.filters.length > 0) {
      console.log('🔄 No results found, trying fallback search...')
      
      const searchTerms = new Set<string>()
      searchParams.filters.forEach((filter: any) => {
        if (filter.value) {
          const cleanTerm = filter.value.replace(/%/g, '').replace(/[\s-]/g, '')
          if (cleanTerm.length > 2) {
            searchTerms.add(cleanTerm)
          }
        }
      })
      
      if (searchTerms.size > 0) {
        const fallbackFilters: string[] = []
        Array.from(searchTerms).forEach(term => {
          fallbackFilters.push(`searchable_text.ilike.%${term}%`)
          fallbackFilters.push(`sku.ilike.%${term}%`)
          fallbackFilters.push(`product_name.ilike.%${term}%`)
          fallbackFilters.push(`name.ilike.%${term}%`)
        })
        
        let fallbackQuery = supabase
          .from('coatings')
          .select('*')
          .or(fallbackFilters.join(','))
          .limit(1000)
        
        fallbackQuery = applyUserFilters(fallbackQuery, filters, columns, [])
        
        const fallbackResult = await fallbackQuery
        
        if (!fallbackResult.error && fallbackResult.data && fallbackResult.data.length > 0) {
          console.log(`✅ Fallback search found ${fallbackResult.data.length} results`)
          data = filterProductsInMemory(fallbackResult.data, filters)
        }
      }
    }

    if (!data || data.length === 0) {
      return NextResponse.json({
        success: true,
        questionType: "list",
        results: [],
        count: 0,
        message: "No coatings found matching your query. Try using different keywords or partial product names."
      })
    }

    const cleanedResults = data.map((product: ProductRecord) => cleanProductData(product))

    // Step 4: Handle comparison questions
    if (searchParams.questionType === "comparison") {
      console.log(`🔄 Comparison mode - found ${cleanedResults.length} products`)
      
      if (cleanedResults.length >= 2) {
        const compareProducts = searchParams.compareProducts || []
        const groupedProducts: ProductRecord[] = []
        
        compareProducts.forEach((term: string) => {
          const cleanTerm = term.replace(/[\s-]/g, '').toLowerCase()
          
          const matchedProduct = cleanedResults.find((p: ProductRecord) => {
            const productStr = JSON.stringify(p).toLowerCase().replace(/[\s-]/g, '')
            return productStr.includes(cleanTerm) && !groupedProducts.includes(p)
          })
          
          if (matchedProduct) {
            groupedProducts.push(matchedProduct)
          }
        })
        
        const productsToCompare = groupedProducts.length >= 2 
          ? groupedProducts.slice(0, 2) 
          : cleanedResults.slice(0, 2)
        
        return NextResponse.json({
          success: true,
          questionType: "comparison",
          products: productsToCompare,
          compareProducts: searchParams.compareProducts || [],
          totalFound: cleanedResults.length
        })
      } else {
        return NextResponse.json({
          success: true,
          questionType: "list",
          results: cleanedResults,
          count: cleanedResults.length,
          message: `Found only ${cleanedResults.length} product(s). Need at least 2 products for comparison.`
        })
      }
    }

    // Step 5: Handle AI-powered specific questions
    if (searchParams.questionType === "specific_ai" && cleanedResults.length > 0) {
      const product = cleanedResults[0]
      const attributeQuestion = searchParams.attributeQuestion || query
      
      console.log('🤖 Using AI to extract answer from product data')
      
      try {
        const productDataString = truncateProductForAI(product, 8000)
        
        const answerCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are a product information assistant. Extract the relevant answer from the product data.

RULES:
- Answer directly and concisely
- If information not found, say "Information not available in product data"
- Extract ALL relevant information
- Format lists with bullet points using "•"
- Remove all HTML tags
- Convert HTML entities (e.g., &deg; to °, &reg; to ®)
- Be specific and complete

PRODUCT DATA:
${productDataString}`
            },
            {
              role: 'user',
              content: attributeQuestion
            }
          ],
          temperature: 0.1,
          max_tokens: 1000
        })
        
        let answer = answerCompletion.choices[0].message.content || 'Information not available'
        answer = stripHtml(answer)
        
        return NextResponse.json({
          success: true,
          questionType: "specific",
          answer: answer,
          extractedData: {
            sku: product.sku || product.product_name || product.name || 'N/A',
            question: attributeQuestion
          },
          fullProduct: product
        })
      } catch (aiError: any) {
        console.error('❌ AI extraction error:', aiError.message)
        return NextResponse.json({
          success: true,
          questionType: "list",
          results: cleanedResults.slice(0, 1),
          count: 1,
          message: "Found product but couldn't extract specific answer. Showing full details."
        })
      }
    }

    // Default: return cleaned results
    return NextResponse.json({
      success: true,
      questionType: "list",
      results: cleanedResults,
      count: cleanedResults.length
    })

  } catch (error: any) {
    console.error('❌ Smart search error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.toString() : undefined
      },
      { status: 500 }
    )
  }
}
